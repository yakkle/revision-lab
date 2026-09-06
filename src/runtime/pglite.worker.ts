/// <reference lib="webworker" />
import { PGlite } from "@electric-sql/pglite";
import { CONTROL, STATE, isPgQuery, isWorkerBoot, rpcError, type PgResult, type RpcFault } from "./protocol";
import { publishResponse } from "./sync-rpc";
import { decodeValue, encodeValue } from "./value-codec";

declare const self: DedicatedWorkerGlobalScope;

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

self.onmessage = async (event: MessageEvent<unknown>) => {
  if (!isWorkerBoot(event.data)) {
    self.postMessage({ type: "ERROR", error: { code: "RPC_INVALID_BOOT", message: "Invalid PGlite Worker boot message" } });
    return;
  }

  const boot = event.data;
  const control = new Int32Array(boot.control);
  const response = new Uint8Array(boot.response);
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
    const database = new PGlite({ dataDir: "memory://", pgliteWasmModule, initdbWasmModule, fsBundle });
    await database.waitReady;

    boot.port.onmessage = async (requestEvent: MessageEvent<unknown>) => {
      const request = requestEvent.data;
      if (!isPgQuery(request)) {
        publishResponse(control, response, Atomics.load(control, CONTROL.REQUEST_SEQUENCE), rpcError("RPC_INVALID_REQUEST"));
        return;
      }
      if (request.workspaceId !== boot.workspaceId || request.protocolVersion !== boot.protocolVersion) {
        publishResponse(control, response, request.sequence, rpcError("RPC_PROTOCOL_ERROR"));
        return;
      }
      if (request.sequence !== Atomics.load(control, CONTROL.REQUEST_SEQUENCE)) {
        publishResponse(control, response, request.sequence, rpcError("RPC_PROTOCOL_ERROR", "Request sequence mismatch"));
        return;
      }

      let result: PgResult;
      try {
        const queryResult = await database.query<unknown[]>(request.sql, request.params.map(decodeValue), { rowMode: "array" });
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
    boot.port.start();
    self.postMessage({ ...boot, port: undefined, control: undefined, response: undefined, type: "READY" });
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
