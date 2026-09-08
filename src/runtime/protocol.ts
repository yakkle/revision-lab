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
export type PGliteReconnect = Envelope & {
  type: "RECONNECT_PGLITE";
  port: MessagePort;
  control: SharedArrayBuffer;
  response: SharedArrayBuffer;
  assetBase: string;
};
export type SqliteWorkerBoot = Envelope & {
  type: "BOOT_SQLITE";
  assetBase: string;
};
export type PythonRun = Envelope & { type: "RUN_PYTHON"; source: string };
export type DatabaseMode = "sqlite" | "postgresql";
export type FileChange = { path: string; change: "added" | "modified" | "deleted" };
export type RevisionNode = {
  revision: string;
  downRevisions: string[];
  branchLabels: string[];
  dependsOn: string[];
  isHead: boolean;
  isBranchPoint: boolean;
  isMergePoint: boolean;
  isCurrent: boolean;
};
export type ColumnSnapshot = {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKeyPosition: number;
};
export type TableSnapshot = {
  name: string;
  columns: ColumnSnapshot[];
  primaryKey: { name: string | null; columns: string[] };
  foreignKeys: Array<{ name: string | null; columns: string[]; referredTable: string; referredColumns: string[]; options: Record<string, unknown> }>;
  uniqueConstraints: Array<{ name: string | null; columns: string[] }>;
  checkConstraints: Array<{ name: string | null; sqlText: string }>;
  indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
};
export type SchemaSnapshot = { dialect: "sqlite"; tables: TableSnapshot[]; alembicVersion: string[] };
export type WorkspaceState = { files: string[]; revisions: RevisionNode[]; schema: SchemaSnapshot };
export type SchemaObjectKind = "table" | "column" | "primaryKey" | "foreignKey" | "uniqueConstraint" | "checkConstraint" | "index";
export type SchemaChange = {
  kind: SchemaObjectKind;
  table: string;
  name: string;
  change: "added" | "modified" | "deleted";
  before?: unknown;
  after?: unknown;
};
export type SchemaDiff = { changes: SchemaChange[]; alembicVersion: { before: string[]; after: string[] } };
export type CommandResult = {
  success: boolean;
  argv: string[];
  stdout: string;
  stderr: string;
  traceback?: string;
  error?: RpcFault;
  fileChanges: FileChange[];
  schemaDiff: SchemaDiff;
  before: WorkspaceState;
  after: WorkspaceState;
};
export type SqliteRuntimeRequest = Envelope & (
  | { type: "CREATE_WORKSPACE" }
  | { type: "RUN_ALEMBIC"; argv: string[] }
  | { type: "READ_FILE"; path: string }
  | { type: "WRITE_FILE"; path: string; content: string }
  | { type: "INSPECT" }
);
export type SqliteRuntimeReply = Envelope & (
  | { type: "READY" }
  | { type: "WORKSPACE_CREATED"; state: WorkspaceState }
  | { type: "COMMAND_RESULT"; result: CommandResult }
  | { type: "FILE_CONTENT"; path: string; content: string }
  | { type: "FILE_WRITTEN"; state: WorkspaceState; fileChanges: FileChange[] }
  | { type: "STATE_SNAPSHOT"; state: WorkspaceState }
  | { type: "ERROR"; error: RpcFault }
);
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

export function isPGliteReconnect(value: unknown): value is PGliteReconnect {
  if (!isEnvelope(value) || !isRecord(value) || value.type !== "RECONNECT_PGLITE") return false;
  try {
    return value.port instanceof MessagePort && value.control instanceof SharedArrayBuffer && value.control.byteLength === CONTROL_BYTES &&
      value.response instanceof SharedArrayBuffer && value.response.byteLength === RESPONSE_BYTES &&
      typeof value.assetBase === "string" && new URL(value.assetBase).origin === location.origin;
  } catch {
    return false;
  }
}

export function isSqliteWorkerBoot(value: unknown): value is SqliteWorkerBoot {
  if (!isEnvelope(value) || !isRecord(value) || value.type !== "BOOT_SQLITE") return false;
  try {
    return typeof value.assetBase === "string" && new URL(value.assetBase).origin === location.origin;
  } catch {
    return false;
  }
}

export function isSqliteRuntimeRequest(value: unknown): value is SqliteRuntimeRequest {
  if (!isEnvelope(value) || !isRecord(value)) return false;
  const validPath = (path: unknown) => typeof path === "string" && path.length > 0 && path.length <= 512 &&
    !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
  if (value.type === "CREATE_WORKSPACE" || value.type === "INSPECT") return true;
  if (value.type === "RUN_ALEMBIC") {
    return Array.isArray(value.argv) && value.argv.length > 0 && value.argv.length <= 64 &&
      value.argv.every((item) => typeof item === "string" && item.length > 0 && item.length <= 4096);
  }
  if (value.type === "READ_FILE") return validPath(value.path);
  return value.type === "WRITE_FILE" && validPath(value.path) &&
    typeof value.content === "string" && new TextEncoder().encode(value.content).length <= 1024 * 1024;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFileChanges(value: unknown): value is FileChange[] {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.path === "string" &&
    (item.change === "added" || item.change === "modified" || item.change === "deleted"));
}

function isRevisionNode(value: unknown): value is RevisionNode {
  return isRecord(value) && typeof value.revision === "string" && isStringArray(value.downRevisions) &&
    isStringArray(value.branchLabels) && isStringArray(value.dependsOn) && typeof value.isHead === "boolean" &&
    typeof value.isBranchPoint === "boolean" && typeof value.isMergePoint === "boolean" && typeof value.isCurrent === "boolean";
}

function isTableSnapshot(value: unknown): value is TableSnapshot {
  if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.columns) ||
    !value.columns.every((column) => isRecord(column) && typeof column.name === "string" && typeof column.type === "string" &&
      typeof column.nullable === "boolean" && (column.default === null || typeof column.default === "string") &&
      Number.isInteger(column.primaryKeyPosition)) || !isRecord(value.primaryKey) ||
    !(value.primaryKey.name === null || typeof value.primaryKey.name === "string") || !isStringArray(value.primaryKey.columns)) return false;
  return Array.isArray(value.foreignKeys) && Array.isArray(value.uniqueConstraints) &&
    Array.isArray(value.checkConstraints) && Array.isArray(value.indexes);
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  return isRecord(value) && isStringArray(value.files) && Array.isArray(value.revisions) && value.revisions.every(isRevisionNode) &&
    isRecord(value.schema) && value.schema.dialect === "sqlite" && Array.isArray(value.schema.tables) &&
    value.schema.tables.every(isTableSnapshot) && isStringArray(value.schema.alembicVersion);
}

function isSchemaDiff(value: unknown): value is SchemaDiff {
  const kinds = new Set<SchemaObjectKind>(["table", "column", "primaryKey", "foreignKey", "uniqueConstraint", "checkConstraint", "index"]);
  return isRecord(value) && Array.isArray(value.changes) && value.changes.every((item) =>
    isRecord(item) && typeof item.kind === "string" && kinds.has(item.kind as SchemaObjectKind) &&
    typeof item.table === "string" && typeof item.name === "string" &&
    (item.change === "added" || item.change === "modified" || item.change === "deleted")) &&
    isRecord(value.alembicVersion) && isStringArray(value.alembicVersion.before) && isStringArray(value.alembicVersion.after);
}

export function isSqliteRuntimeReply(value: unknown): value is SqliteRuntimeReply {
  if (!isEnvelope(value) || !isRecord(value)) return false;
  if (value.type === "READY") return true;
  if (value.type === "ERROR") return isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string";
  if (value.type === "WORKSPACE_CREATED" || value.type === "STATE_SNAPSHOT") return isWorkspaceState(value.state);
  if (value.type === "FILE_CONTENT") return typeof value.path === "string" && typeof value.content === "string";
  if (value.type === "FILE_WRITTEN") return isWorkspaceState(value.state) && isFileChanges(value.fileChanges);
  return value.type === "COMMAND_RESULT" && isRecord(value.result) && typeof value.result.success === "boolean" &&
    Array.isArray(value.result.argv) && typeof value.result.stdout === "string" && typeof value.result.stderr === "string" &&
    isFileChanges(value.result.fileChanges) && isSchemaDiff(value.result.schemaDiff) &&
    isWorkspaceState(value.result.before) && isWorkspaceState(value.result.after) &&
    (value.result.error === undefined || (isRecord(value.result.error) && typeof value.result.error.code === "string" && typeof value.result.error.message === "string"));
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
