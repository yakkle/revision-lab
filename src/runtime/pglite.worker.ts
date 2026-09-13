/// <reference lib="webworker" />
import { PGlite } from "@electric-sql/pglite";
import {
  CONTROL, STATE, isPGliteDelete, isPGliteExport, isPGliteReconnect, isPgRequest, isWorkerBoot, rpcError,
  type PGliteReconnect, type PgResult, type RpcFault, type TaggedValue, type WorkerBoot,
} from "./protocol";
import { publishResponse } from "./sync-rpc";
import { decodeValue, encodeValue } from "./value-codec";

declare const self: DedicatedWorkerGlobalScope;

type PGliteConnection = WorkerBoot | PGliteReconnect;

let database: PGlite | undefined;
let workspaceId: string | undefined;
let databaseId: string | undefined;
let activePort: MessagePort | undefined;

// PGlite 0.5.8's IDBFS adapter creates one mount directory with FS.mkdir,
// so the dataDir name must be a single path segment rather than a nested path.
const dataDirName = (id: string) => `revision-lab-${id}`;

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Emscripten IDBFS keys the backing database by its mount path.
    const request = indexedDB.deleteDatabase(`/pglite/${name}`);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("PGlite IndexedDB deletion failed"));
    // A page reload can briefly retain the previous Worker's IDBFS connection.
    // Keep the deletion request pending; IndexedDB completes it after that
    // connection is released.
    request.onblocked = () => undefined;
  });
}

function textProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : undefined;
}

function databaseFault(error: unknown): RpcFault {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "PGLITE_DATABASE_ERROR",
    message,
    sqlState: textProperty(error, "code") ?? textProperty(error, "sqlState"),
    detail: textProperty(error, "detail"),
    hint: textProperty(error, "hint"),
  };
}

async function executeMany(sql: string, paramSets: TaggedValue[][]) {
  if (paramSets.length === 0) {
    return { rows: [], fields: [], rowCount: 0, affectedRows: 0, command: "" };
  }
  let rowCount = 0;
  let last = await database!.query<unknown[]>(sql, paramSets[0]!.map(decodeValue), { rowMode: "array" });
  rowCount += last.rowCount ?? last.affectedRows ?? last.rows.length;
  for (const params of paramSets.slice(1)) {
    last = await database!.query<unknown[]>(sql, params.map(decodeValue), { rowMode: "array" });
    rowCount += last.rowCount ?? last.affectedRows ?? last.rows.length;
  }
  return { ...last, rows: [], rowCount, affectedRows: rowCount };
}

function attachConnection(connection: PGliteConnection): void {
  if (!database) throw new Error("PGlite is not initialized");
  const control = new Int32Array(connection.control);
  const response = new Uint8Array(connection.response);
  activePort?.close();
  activePort = connection.port;
  activePort.onmessage = async (requestEvent: MessageEvent<unknown>) => {
    const request = requestEvent.data;
    if (!isPgRequest(request)) {
      publishResponse(control, response, Atomics.load(control, CONTROL.REQUEST_SEQUENCE), rpcError("RPC_INVALID_REQUEST"));
      return;
    }
    if (request.workspaceId !== connection.workspaceId || request.protocolVersion !== connection.protocolVersion) {
      publishResponse(control, response, request.sequence, rpcError("RPC_PROTOCOL_ERROR"));
      return;
    }
    if (request.sequence !== Atomics.load(control, CONTROL.REQUEST_SEQUENCE)) {
      publishResponse(control, response, request.sequence, rpcError("RPC_PROTOCOL_ERROR", "Request sequence mismatch"));
      return;
    }

    let result: PgResult;
    try {
      const queryResult = request.op === "QUERY"
        ? await database!.query<unknown[]>(request.sql, request.params.map(decodeValue), { rowMode: "array" })
        : await executeMany(request.sql, request.paramSets);
      const fields = queryResult.fields.map((field) => ({ name: field.name, dataTypeId: field.dataTypeID }));
      result = {
        ok: true,
        rows: queryResult.rows.map((row) => row.map((value, index) => encodeValue(value, fields[index]?.dataTypeId))),
        fields,
        rowCount: queryResult.rowCount ?? queryResult.affectedRows ?? queryResult.rows.length,
        commandTag: queryResult.command,
      };
    } catch (error) {
      const fault = error instanceof Error && error.message === "UNSUPPORTED_VALUE_TYPE"
        ? { code: "UNSUPPORTED_VALUE_TYPE", message: error.message }
        : databaseFault(error);
      result = { ok: false, error: fault };
    }
    publishResponse(control, response, request.sequence, result);
  };
  activePort.start();
}

function ready(connection: PGliteConnection): void {
  self.postMessage({
    protocolVersion: connection.protocolVersion,
    requestId: connection.requestId,
    workspaceId: connection.workspaceId,
    type: "READY",
  });
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  if (isPGliteDelete(event.data)) {
    const request = event.data;
    if (workspaceId !== request.workspaceId) {
      self.postMessage({ ...request, type: "ERROR", error: { code: "PGLITE_DELETE_FAILED", message: "PGlite Worker has no matching database" } });
      return;
    }
    try {
      activePort?.close();
      activePort = undefined;
      await database?.close();
      database = undefined;
      if (databaseId) await deleteDatabase(dataDirName(databaseId));
      workspaceId = undefined;
      databaseId = undefined;
      self.postMessage({ ...request, type: "PGLITE_DELETED" });
    } catch (error) {
      self.postMessage({ ...request, type: "ERROR", error: { code: "PGLITE_DELETE_FAILED", message: error instanceof Error ? error.message : String(error) } });
    }
    return;
  }

  if (isPGliteExport(event.data)) {
    const request = event.data;
    if (!database || workspaceId !== request.workspaceId) {
      self.postMessage({ ...request, type: "ERROR", error: { code: "PGLITE_EXPORT_FAILED", message: "PGlite Worker has no matching database" } });
      return;
    }
    try {
      const dump = await database.dumpDataDir("gzip");
      self.postMessage({ ...request, type: "PGLITE_EXPORTED", dump });
    } catch (error) {
      self.postMessage({ ...request, type: "ERROR", error: { code: "PGLITE_EXPORT_FAILED", message: error instanceof Error ? error.message : String(error) } });
    }
    return;
  }

  if (isPGliteReconnect(event.data)) {
    const connection = event.data;
    if (!database || workspaceId !== connection.workspaceId) {
      self.postMessage({
        protocolVersion: connection.protocolVersion,
        requestId: connection.requestId,
        workspaceId: connection.workspaceId,
        type: "ERROR",
        error: { code: "PGLITE_RECONNECT_FAILED", message: "PGlite Worker has no matching database" },
      });
      return;
    }
    attachConnection(connection);
    ready(connection);
    return;
  }

  if (!isWorkerBoot(event.data)) {
    self.postMessage({ type: "ERROR", error: { code: "RPC_INVALID_BOOT", message: "Invalid PGlite Worker boot message" } });
    return;
  }

  const boot = event.data;
  const control = new Int32Array(boot.control);
  try {
    const runtimeBase = new URL("pglite/", boot.assetBase);
    const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
      WebAssembly.compileStreaming(fetch(new URL("pglite.wasm", runtimeBase))),
      WebAssembly.compileStreaming(fetch(new URL("initdb.wasm", runtimeBase))),
      fetch(new URL("pglite.data", runtimeBase)).then((result) => {
        if (!result.ok) throw new Error(`PGlite data request failed: ${result.status}`);
        return result.blob();
      }),
    ]);
    const dataDir = dataDirName(boot.databaseId);
    if (boot.databaseDump) await deleteDatabase(dataDir);
    database = new PGlite({
      dataDir: `idb://${dataDir}`, pgliteWasmModule, initdbWasmModule, fsBundle,
      loadDataDir: boot.databaseDump,
      // Preserve JSON text across the tagged string transport. SQLAlchemy's
      // JSON result processor decodes it in Python, without JS number loss.
      parsers: { 114: (value) => value, 3802: (value) => value },
    });
    await database.waitReady;
    workspaceId = boot.workspaceId;
    databaseId = boot.databaseId;
    attachConnection(boot);
    ready(boot);
    if (boot.previousDatabaseId && boot.previousDatabaseId !== boot.databaseId) {
      void deleteDatabase(dataDirName(boot.previousDatabaseId)).catch(() => undefined);
    }
  } catch (error) {
    Atomics.store(control, CONTROL.STATE, STATE.BROKEN);
    Atomics.notify(control, CONTROL.STATE);
    self.postMessage({
      protocolVersion: boot.protocolVersion,
      requestId: boot.requestId,
      workspaceId: boot.workspaceId,
      type: "ERROR",
      error: { code: "PGLITE_BOOT_FAILED", message: error instanceof Error ? error.message : String(error) },
    });
  }
};
