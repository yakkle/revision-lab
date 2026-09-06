export const PROTOCOL_VERSION = 1 as const;
export const CONTROL_BYTES = 64;
export const RESPONSE_BYTES = 8 * 1024 * 1024;
export const RPC_TIMEOUT_MS = 15_000;

export const CONTROL = { STATE: 0, LENGTH: 1, REQUEST_SEQUENCE: 2, RESPONSE_SEQUENCE: 3 } as const;
export const STATE = { IDLE: 0, WAITING: 1, OK: 2, ERROR: 3, BROKEN: 4 } as const;

export type Envelope = { protocolVersion: 1; requestId: string; workspaceId: string };
export type TaggedValue =
  | { tag: "null" }
  | { tag: "boolean"; value: boolean }
  | { tag: "number"; value: number }
  | { tag: "special-number"; value: "NaN" | "Infinity" | "-Infinity" }
  | { tag: "string"; value: string }
  | { tag: "bigint" | "decimal"; value: string }
  | { tag: "date" | "time" | "timestamp"; value: string; dataTypeId: number }
  | { tag: "bytea"; value: string }
  | { tag: "array"; value: TaggedValue[] };
export type RpcFault = { code: string; message: string; sqlState?: string; detail?: string; hint?: string; traceback?: string };
export type PgResult =
  | { ok: true; rows: TaggedValue[][]; fields: Array<{ name: string; dataTypeId: number }>; rowCount: number; commandTag?: string }
  | { ok: false; error: RpcFault };
export type PgQuery = Envelope & { op: "QUERY"; sequence: number; sql: string; params: TaggedValue[] };
export type WorkerBoot = Envelope & {
  type: "BOOT";
  port: MessagePort;
  control: SharedArrayBuffer;
  response: SharedArrayBuffer;
  assetBase: string;
};
export type PythonRun = Envelope & { type: "RUN_PYTHON"; source: string };
export type PythonReply = Envelope & (
  | { type: "READY" }
  | { type: "RESULT"; value: string }
  | { type: "ERROR"; error: RpcFault }
);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isEnvelope(value: unknown): value is Envelope & Record<string, unknown> {
  return isRecord(value) && value.protocolVersion === PROTOCOL_VERSION &&
    typeof value.requestId === "string" && value.requestId.length > 0 &&
    typeof value.workspaceId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value.workspaceId);
}

export function isPythonRun(value: unknown): value is PythonRun {
  return isEnvelope(value) && value.type === "RUN_PYTHON" && typeof value.source === "string";
}

export function isTaggedValue(value: unknown): value is TaggedValue {
  if (!isRecord(value) || typeof value.tag !== "string") return false;
  if (value.tag === "null") return true;
  if (value.tag === "boolean") return typeof value.value === "boolean";
  if (value.tag === "string" || value.tag === "bigint" || value.tag === "decimal" || value.tag === "bytea") return typeof value.value === "string";
  if (value.tag === "number") return typeof value.value === "number" && Number.isFinite(value.value) && (!Number.isInteger(value.value) || Number.isSafeInteger(value.value));
  if (value.tag === "special-number") return value.value === "NaN" || value.value === "Infinity" || value.value === "-Infinity";
  if (value.tag === "date" || value.tag === "time" || value.tag === "timestamp") return typeof value.value === "string" && Number.isInteger(value.dataTypeId);
  if (value.tag === "array") return Array.isArray(value.value) && value.value.every(isTaggedValue);
  return false;
}

export function isPgQuery(value: unknown): value is PgQuery {
  return isEnvelope(value) && isRecord(value) && value.op === "QUERY" &&
    Number.isInteger(value.sequence) && Number(value.sequence) > 0 && typeof value.sql === "string" &&
    Array.isArray(value.params) && value.params.every(isTaggedValue);
}

export function isWorkerBoot(value: unknown): value is WorkerBoot {
  if (!isEnvelope(value) || !isRecord(value) || value.type !== "BOOT") return false;
  try {
    return value.port instanceof MessagePort && value.control instanceof SharedArrayBuffer && value.control.byteLength === CONTROL_BYTES &&
      value.response instanceof SharedArrayBuffer && value.response.byteLength === RESPONSE_BYTES &&
      typeof value.assetBase === "string" && new URL(value.assetBase).origin === location.origin;
  } catch {
    return false;
  }
}

export function rpcError(code: string, message = code): PgResult {
  return { ok: false, error: { code, message } };
}

export function isPgResult(value: unknown): value is PgResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string";
  return value.ok === true && Array.isArray(value.rows) && value.rows.every((row) => Array.isArray(row) && row.every(isTaggedValue)) &&
    Array.isArray(value.fields) && value.fields.every((field) => isRecord(field) && typeof field.name === "string" && Number.isInteger(field.dataTypeId)) &&
    Number.isInteger(value.rowCount);
}
