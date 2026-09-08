/// <reference lib="webworker" />
import type { PyodideInterface } from "pyodide";
import {
  isEnvelope, isPythonRun, isSqliteRuntimeRequest, isSqliteWorkerBoot, isTaggedValue, isWorkerBoot,
  type PythonReply, type SqliteRuntimeReply, type TaggedValue,
} from "./protocol";
import { SyncRpc } from "./sync-rpc";
import PGLITE_DBAPI_SOURCE from "./python/pglite_dbapi.py?raw";
import PGLITE_SQLALCHEMY_SOURCE from "./python/pglite_sqlalchemy.py?raw";
import ALEMBIC_RUNTIME_SOURCE from "./python/alembic_runtime.py?raw";

declare const self: DedicatedWorkerGlobalScope;

const PYTHON_BRIDGE = String.raw`
import base64
import datetime
import decimal
import json

def _tag(value):
    if value is None:
        return {"tag": "null"}
    if isinstance(value, bool):
        return {"tag": "boolean", "value": value}
    if isinstance(value, int):
        if abs(value) > 9007199254740991:
            return {"tag": "bigint", "value": str(value)}
        return {"tag": "number", "value": value}
    if isinstance(value, float):
        if value != value:
            return {"tag": "special-number", "value": "NaN"}
        if value == float("inf"):
            return {"tag": "special-number", "value": "Infinity"}
        if value == float("-inf"):
            return {"tag": "special-number", "value": "-Infinity"}
        return {"tag": "number", "value": value}
    if isinstance(value, str):
        return {"tag": "string", "value": value}
    if isinstance(value, decimal.Decimal):
        return {"tag": "decimal", "value": str(value)}
    if isinstance(value, bytes):
        return {"tag": "bytea", "value": base64.b64encode(value).decode("ascii")}
    if isinstance(value, datetime.datetime):
        return {"tag": "timestamp", "value": value.isoformat(), "dataTypeId": 1114}
    if isinstance(value, datetime.date):
        return {"tag": "date", "value": value.isoformat(), "dataTypeId": 1082}
    if isinstance(value, datetime.time):
        return {"tag": "time", "value": value.isoformat(), "dataTypeId": 1083}
    if isinstance(value, (list, tuple)):
        return {"tag": "array", "value": [_tag(item) for item in value]}
    raise TypeError("UNSUPPORTED_VALUE_TYPE")

def pg_query(sql, params=None):
    tagged = [_tag(value) for value in (params or [])]
    return json.loads(str(__revision_lab_query(sql, json.dumps(tagged))))

def pg_execute_many(sql, param_sets):
    tagged_sets = [[_tag(value) for value in params] for params in param_sets]
    return json.loads(str(__revision_lab_execute_many(sql, json.dumps(tagged_sets))))
`;

let pyodide: PyodideInterface | undefined;
let bootContext: { protocolVersion: 1; workspaceId: string; mode: "technical-probe" | "sqlite" | "postgresql" } | undefined;

async function loadAlembic(runtime: PyodideInterface, assetBase: string): Promise<void> {
  await runtime.loadPackage(["micropip", "sqlalchemy", "markupsafe"]);
  const wheelBase = new URL("wheels/", assetBase);
  runtime.globals.set("__revision_lab_wheels", [
    new URL("mako-1.3.10-py3-none-any.whl", wheelBase).href,
    new URL("alembic-1.19.1-py3-none-any.whl", wheelBase).href,
  ]);
  await runtime.runPythonAsync("import micropip\nawait micropip.install(__revision_lab_wheels, deps=False)");
  runtime.globals.delete("__revision_lab_wheels");
  runtime.runPython(ALEMBIC_RUNTIME_SOURCE);
}

function send(reply: PythonReply | SqliteRuntimeReply): void {
  self.postMessage(reply);
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  if (isSqliteWorkerBoot(event.data)) {
    const boot = event.data;
    try {
      const pyodideBase = new URL("pyodide/", boot.assetBase);
      const pyodideModule = await import(/* @vite-ignore */ new URL("pyodide.mjs", pyodideBase).href) as typeof import("pyodide");
      pyodide = await pyodideModule.loadPyodide({ indexURL: pyodideBase.href });
      await loadAlembic(pyodide, boot.assetBase);
      bootContext = { protocolVersion: boot.protocolVersion, workspaceId: boot.workspaceId, mode: "sqlite" };
      send({ ...boot, type: "READY" });
    } catch (error) {
      send({
        ...boot,
        type: "ERROR",
        error: { code: "SQLITE_BOOT_FAILED", message: error instanceof Error ? error.message : String(error), traceback: error instanceof Error ? error.stack : undefined },
      });
    }
    return;
  }

  if (isWorkerBoot(event.data)) {
    const boot = event.data;
    try {
      const rpc = new SyncRpc(
        boot.port,
        new Int32Array(boot.control),
        new Uint8Array(boot.response),
        { protocolVersion: boot.protocolVersion, requestId: boot.requestId, workspaceId: boot.workspaceId },
      );
      const pyodideBase = new URL("pyodide/", boot.assetBase);
      const pyodideModule = await import(/* @vite-ignore */ new URL("pyodide.mjs", pyodideBase).href) as typeof import("pyodide");
      pyodide = await pyodideModule.loadPyodide({ indexURL: pyodideBase.href });
      await pyodide.loadPackage(["sqlalchemy", "typing-extensions"]);
      pyodide.globals.set("__revision_lab_query", (sql: unknown, encodedParams: unknown) => {
        const decoded: unknown = JSON.parse(String(encodedParams));
        if (!Array.isArray(decoded) || !decoded.every(isTaggedValue)) {
          return JSON.stringify({ ok: false, error: { code: "RPC_INVALID_PARAMS", message: "Invalid tagged parameters" } });
        }
        return JSON.stringify(rpc.query(String(sql), decoded as TaggedValue[]));
      });
      pyodide.globals.set("__revision_lab_execute_many", (sql: unknown, encodedParamSets: unknown) => {
        const decoded: unknown = JSON.parse(String(encodedParamSets));
        if (!Array.isArray(decoded) || !decoded.every((params) => Array.isArray(params) && params.every(isTaggedValue))) {
          return JSON.stringify({ ok: false, error: { code: "RPC_INVALID_PARAMS", message: "Invalid tagged parameter sets" } });
        }
        return JSON.stringify(rpc.executeMany(String(sql), decoded as TaggedValue[][]));
      });
      pyodide.runPython(PYTHON_BRIDGE);
      pyodide.globals.set("__revision_lab_dbapi_source", PGLITE_DBAPI_SOURCE);
      pyodide.globals.set("__revision_lab_dialect_source", PGLITE_SQLALCHEMY_SOURCE);
      pyodide.runPython(String.raw`
import sys
import types

def _revision_lab_install_module(name, source, filename):
    module = types.ModuleType(name)
    module.__file__ = filename
    sys.modules[name] = module
    exec(compile(source, filename, "exec"), module.__dict__)
    return module

_pglite_dbapi = _revision_lab_install_module("pglite_dbapi", __revision_lab_dbapi_source, "pglite_dbapi.py")
_pglite_dbapi.configure(pg_query, pg_execute_many)
_revision_lab_install_module("pglite_sqlalchemy", __revision_lab_dialect_source, "pglite_sqlalchemy.py")
`);
      pyodide.globals.delete("__revision_lab_dbapi_source");
      pyodide.globals.delete("__revision_lab_dialect_source");
      if (boot.runtime === "alembic") {
        await loadAlembic(pyodide, boot.assetBase);
        pyodide.runPython('DATABASE_MODE = "postgresql"');
      }
      bootContext = { protocolVersion: boot.protocolVersion, workspaceId: boot.workspaceId, mode: boot.runtime === "alembic" ? "postgresql" : "technical-probe" };
      send({ protocolVersion: boot.protocolVersion, requestId: boot.requestId, workspaceId: boot.workspaceId, type: "READY" });
    } catch (error) {
      send({
        protocolVersion: boot.protocolVersion,
        requestId: boot.requestId,
        workspaceId: boot.workspaceId,
        type: "ERROR",
        error: { code: "PYODIDE_BOOT_FAILED", message: error instanceof Error ? error.message : String(error), traceback: error instanceof Error ? error.stack : undefined },
      });
    }
    return;
  }

  const value = event.data;
  if (bootContext?.mode === "sqlite" || bootContext?.mode === "postgresql") {
    if (!isSqliteRuntimeRequest(value) || !pyodide || value.workspaceId !== bootContext.workspaceId) {
      const context = isEnvelope(value)
        ? { protocolVersion: value.protocolVersion, requestId: value.requestId, workspaceId: value.workspaceId }
        : { protocolVersion: 1 as const, requestId: "invalid", workspaceId: "invalid" };
      send({ ...context, type: "ERROR", error: { code: "RUNTIME_INVALID_REQUEST", message: "Invalid Alembic runtime request" } });
      return;
    }
    try {
      const request = JSON.stringify(value);
      pyodide.globals.set("__revision_lab_request", request);
      const encoded = String(pyodide.runPython("handle_safely(__revision_lab_request)"));
      pyodide.globals.delete("__revision_lab_request");
      const payload = JSON.parse(encoded) as SqliteRuntimeReply;
      self.postMessage({
        ...payload,
        protocolVersion: value.protocolVersion,
        requestId: value.requestId,
        workspaceId: value.workspaceId,
      });
    } catch (error) {
      send({
        ...value,
        type: "ERROR",
        error: { code: "ALEMBIC_RUNTIME_ERROR", message: error instanceof Error ? error.message : String(error), traceback: error instanceof Error ? error.stack : undefined },
      });
    }
    return;
  }

  if (!isPythonRun(value) || !pyodide || !bootContext || value.workspaceId !== bootContext.workspaceId) {
    const context = isPythonRun(value) ? value : { protocolVersion: 1 as const, requestId: "invalid", workspaceId: "invalid" };
    send({ ...context, type: "ERROR", error: { code: "RUNTIME_INVALID_REQUEST", message: "Invalid Python Worker request" } });
    return;
  }

  try {
    const result = pyodide.runPython(value.source);
    const serialized = String(result);
    if (typeof result === "object" && result !== null && "destroy" in result && typeof result.destroy === "function") result.destroy();
    send({ ...value, type: "RESULT", value: serialized });
  } catch (error) {
    send({
      ...value,
      type: "ERROR",
      error: { code: "PYTHON_EXECUTION_ERROR", message: error instanceof Error ? error.message : String(error), traceback: error instanceof Error ? error.stack : undefined },
    });
  }
};
