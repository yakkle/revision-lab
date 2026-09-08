import {
  CONTROL, CONTROL_BYTES, PROTOCOL_VERSION, RESPONSE_BYTES, STATE, isEnvelope, isPgResult, isRecord,
  type PGliteReconnect, type PgResult, type PythonReply, type RpcFault, type WorkerBoot,
} from "./protocol";

export type ProbeReport = {
  ddl: PgResult;
  insert: PgResult;
  select: PgResult;
  databaseError: PgResult;
  serialCount: number;
  animationFrames: number;
  elapsedMs: number;
};

export type DbapiProbeReport = {
  engine: { dialect: string; driver: string };
  selected: { id: number; parentId: number; code: string; score: number };
  executemanyRowCount: number;
  rolledBackCount: number;
  values: { value: string; type: string }[];
  inspection: {
    primaryKey: string[];
    foreignKeys: Array<{ columns: string[]; referredTable: string; referredColumns: string[] }>;
    uniqueConstraints: string[][];
    checkConstraints: string[];
    indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
  };
  integrityError: { className: string; sqlState?: string; message: string };
  unsupportedError: { className: string; code?: string };
  secondConnectionError: { className: string; code?: string };
};

export class RuntimeClientError extends Error {
  constructor(readonly fault: RpcFault) {
    super(fault.message);
    this.name = "RuntimeClientError";
  }
}

function encodeForPython(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type BootReply = Extract<PythonReply, { type: "READY" | "ERROR" }>;

function bootReply(value: unknown, requestId: string): value is BootReply {
  return isEnvelope(value) && isRecord(value) && value.requestId === requestId &&
    (value.type === "READY" || (value.type === "ERROR" && isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string"));
}

function waitForBoot(worker: Worker, requestId: string, role: "Pyodide" | "PGlite"): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (error) reject(error); else resolve();
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!bootReply(event.data, requestId)) return;
      if (event.data.type === "READY") finish();
      else finish(new RuntimeClientError(event.data.error));
    };
    const onError = (event: ErrorEvent) => finish(new RuntimeClientError({
      code: "RUNTIME_WORKER_CRASH",
      message: event.message || `${role} Worker crashed during boot`,
      detail: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    }));
    const timeout = window.setTimeout(() => finish(new RuntimeClientError({
      code: "RUNTIME_BOOT_TIMEOUT",
      message: `${role} Worker boot exceeded 60 seconds`,
    })), 60_000);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

export class RuntimeClient {
  private pyodideWorker?: Worker;
  private pgliteWorker?: Worker;
  private control?: Int32Array;
  private starting?: Promise<void>;
  private recovering?: Promise<void>;
  private readonly workspaceId = `t2-${crypto.randomUUID()}`;
  private readonly pending = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>();

  start(): Promise<void> {
    if (this.recovering) return this.recovering;
    this.starting ??= this.boot();
    return this.starting;
  }

  async restart(): Promise<void> {
    if (this.recovering) return this.recovering;
    const recovery = this.restartWorkers();
    this.recovering = recovery;
    try {
      await recovery;
    } finally {
      if (this.recovering === recovery) this.recovering = undefined;
    }
  }

  close(): void {
    this.stop(new RuntimeClientError({ code: "RUNTIME_CLOSED", message: "Runtime closed" }));
    this.starting = undefined;
    this.recovering = undefined;
  }

  async query(sql: string, params: unknown[] = []): Promise<PgResult> {
    const encodedSql = encodeForPython(sql);
    const encodedParams = encodeForPython(JSON.stringify(params));
    const source = `import base64, json\njson.dumps(pg_query(base64.b64decode("${encodedSql}").decode("utf-8"), json.loads(base64.b64decode("${encodedParams}").decode("utf-8"))))`;
    const value = await this.runPython(source);
    const parsed: unknown = JSON.parse(value);
    if (!isPgResult(parsed)) throw new RuntimeClientError({ code: "RUNTIME_INVALID_RESPONSE", message: "Python returned an invalid RPC result" });
    if (!parsed.ok && ["RPC_TIMEOUT", "RPC_WORKER_TERMINATED", "RPC_PROTOCOL_ERROR"].includes(parsed.error.code)) {
      void this.restart().catch(() => undefined);
    }
    return parsed;
  }

  async runTechnicalProbe(): Promise<ProbeReport> {
    await this.start();
    let animationFrames = 0;
    let active = true;
    const countFrame = () => {
      animationFrames += 1;
      if (active) requestAnimationFrame(countFrame);
    };
    requestAnimationFrame(countFrame);
    const started = performance.now();
    const value = await this.runPython(String.raw`
import json
pg_query("SELECT pg_sleep(0.1)")
pg_query("DROP TABLE IF EXISTS t2_items")
ddl = pg_query("CREATE TABLE t2_items (id integer PRIMARY KEY, label text NOT NULL)")
insert = pg_query("INSERT INTO t2_items (id, label) VALUES ($1, $2)", [1, "worker-rpc"])
selected = pg_query("SELECT id, label FROM t2_items WHERE id = $1", [1])
database_error = pg_query("INSERT INTO t2_items (id, label) VALUES ($1, $2)", [1, "duplicate"])
serial_count = 0
for index in range(100):
    result = pg_query("SELECT $1::integer AS sequence", [index])
    if result.get("ok") and result["rows"][0][0].get("value") == index:
        serial_count += 1
json.dumps({"ddl": ddl, "insert": insert, "select": selected, "databaseError": database_error, "serialCount": serial_count})
`);
    active = false;
    const parsed = JSON.parse(value) as Omit<ProbeReport, "animationFrames" | "elapsedMs">;
    return { ...parsed, animationFrames, elapsedMs: Math.round(performance.now() - started) };
  }

  async runDbapiProbe(): Promise<DbapiProbeReport> {
    const value = await this.runPython(String.raw`
import datetime
import decimal
import json

import pglite_dbapi
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError as SAIntegrityError

engine = create_engine("postgresql+pglite://")
with engine.connect() as connection:
    connection.exec_driver_sql("DROP TABLE IF EXISTS t4_children")
    connection.exec_driver_sql("DROP TABLE IF EXISTS t4_parents")
    connection.exec_driver_sql("CREATE TABLE t4_parents (id integer PRIMARY KEY)")
    connection.exec_driver_sql("""CREATE TABLE t4_children (
        id integer PRIMARY KEY,
        parent_id integer NOT NULL REFERENCES t4_parents(id),
        code text NOT NULL CONSTRAINT uq_t4_children_code UNIQUE,
        score integer NOT NULL CONSTRAINT ck_t4_children_score CHECK (score >= 0)
    )""")
    connection.exec_driver_sql("CREATE INDEX ix_t4_children_parent_id ON t4_children (parent_id)")
    connection.execute(text("INSERT INTO t4_parents (id) VALUES (:id)"), [{"id": 1}, {"id": 2}])
    inserted = connection.execute(
        text("INSERT INTO t4_children (id, parent_id, code, score) VALUES (:id, :parent_id, :code, :score)"),
        [
            {"id": 1, "parent_id": 1, "code": "alpha", "score": 10},
            {"id": 2, "parent_id": 2, "code": "beta", "score": 20},
        ],
    )
    executemany_row_count = inserted.rowcount
    connection.commit()

    selected_row = connection.execute(
        text("SELECT id, parent_id, code, score FROM t4_children WHERE id = :id"), {"id": 2}
    ).mappings().one()
    selected = {
        "id": selected_row["id"],
        "parentId": selected_row["parent_id"],
        "code": selected_row["code"],
        "score": selected_row["score"],
    }
    connection.execute(text("INSERT INTO t4_children (id, parent_id, code, score) VALUES (3, 1, 'rollback', 30)"))
    connection.rollback()
    rolled_back_count = connection.scalar(text("SELECT count(*) FROM t4_children WHERE id = 3"))

    raw_connection = connection.connection.driver_connection
    cursor = raw_connection.cursor()
    cursor.execute(
        "SELECT $1::bigint, $2::numeric, $3::date, $4::bytea",
        (9007199254740993, decimal.Decimal("1234567890.12345"), datetime.date(2026, 9, 8), b"revision-lab"),
    )
    codec_row = cursor.fetchone()
    values = [{"value": str(item), "type": type(item).__name__} for item in codec_row]
    cursor.close()
    raw_connection.rollback()

    inspector = inspect(connection)
    primary_key = inspector.get_pk_constraint("t4_children")
    foreign_keys = inspector.get_foreign_keys("t4_children")
    unique_constraints = inspector.get_unique_constraints("t4_children")
    check_constraints = inspector.get_check_constraints("t4_children")
    indexes = inspector.get_indexes("t4_children")
    inspection = {
        "primaryKey": primary_key["constrained_columns"],
        "foreignKeys": [
            {
                "columns": item["constrained_columns"],
                "referredTable": item["referred_table"],
                "referredColumns": item["referred_columns"],
            }
            for item in foreign_keys
        ],
        "uniqueConstraints": [item["column_names"] for item in unique_constraints],
        "checkConstraints": [item["sqltext"] for item in check_constraints],
        "indexes": [
            {"name": item["name"], "columns": item["column_names"], "unique": item["unique"]}
            for item in indexes
        ],
    }

    try:
        connection.execute(text("INSERT INTO t4_children (id, parent_id, code, score) VALUES (4, 1, 'alpha', 40)"))
        integrity_error = {"className": "missing", "message": "constraint did not fail"}
    except SAIntegrityError as error:
        original = error.orig
        integrity_error = {
            "className": type(original).__name__,
            "sqlState": original.sqlstate,
            "message": str(original),
        }
        connection.rollback()

    try:
        raw_connection.cursor().callproc("unsupported")
        unsupported_error = {"className": "missing"}
    except pglite_dbapi.NotSupportedError as error:
        unsupported_error = {"className": type(error).__name__, "code": error.code}

    try:
        pglite_dbapi.connect()
        second_connection_error = {"className": "missing"}
    except pglite_dbapi.InterfaceError as error:
        second_connection_error = {"className": type(error).__name__, "code": error.code}

report = {
    "engine": {"dialect": engine.dialect.name, "driver": engine.dialect.driver},
    "selected": selected,
    "executemanyRowCount": executemany_row_count,
    "rolledBackCount": rolled_back_count,
    "values": values,
    "inspection": inspection,
    "integrityError": integrity_error,
    "unsupportedError": unsupported_error,
    "secondConnectionError": second_connection_error,
}
json.dumps(report)
`);
    return JSON.parse(value) as DbapiProbeReport;
  }

  private async runPython(source: string): Promise<string> {
    await this.start();
    const worker = this.pyodideWorker;
    if (!worker) throw new RuntimeClientError({ code: "RUNTIME_NOT_READY", message: "Pyodide Worker is not ready" });
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage({ protocolVersion: PROTOCOL_VERSION, requestId, workspaceId: this.workspaceId, type: "RUN_PYTHON", source });
    });
  }

  private async boot(reconnectPglite = false): Promise<void> {
    if (!crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
      throw new RuntimeClientError({ code: "RUNTIME_ISOLATION_REQUIRED", message: "PostgreSQL mode requires cross-origin isolation" });
    }
    const channel = new MessageChannel();
    const controlBuffer = new SharedArrayBuffer(CONTROL_BYTES);
    const responseBuffer = new SharedArrayBuffer(RESPONSE_BYTES);
    const control = new Int32Array(controlBuffer);
    const assetBase = new URL(`${import.meta.env.BASE_URL}runtime/`, location.href).href;
    const bootId = crypto.randomUUID();
    const context = { protocolVersion: PROTOCOL_VERSION, requestId: bootId, workspaceId: this.workspaceId };
    const pyodideWorker = new Worker(new URL("./pyodide.worker.ts", import.meta.url), { type: "module", name: "revision-lab-pyodide" });
    const existingPgliteWorker = reconnectPglite ? this.pgliteWorker : undefined;
    const pgliteWorker = existingPgliteWorker ?? new Worker(new URL("./pglite.worker.ts", import.meta.url), { type: "module", name: "revision-lab-pglite" });
    const createdPgliteWorker = !existingPgliteWorker;
    this.pyodideWorker = pyodideWorker;
    this.pgliteWorker = pgliteWorker;
    this.control = control;

    pyodideWorker.addEventListener("message", this.handlePythonMessage);
    if (createdPgliteWorker) {
      const markDatabaseBroken = () => {
        if (this.pgliteWorker === pgliteWorker) this.pgliteWorker = undefined;
        this.markControlBroken();
      };
      pgliteWorker.addEventListener("error", markDatabaseBroken);
      pgliteWorker.addEventListener("messageerror", markDatabaseBroken);
    }

    const common = { ...context, type: "BOOT", control: controlBuffer, response: responseBuffer, assetBase } satisfies Omit<WorkerBoot, "port">;
    const pgliteConnection: WorkerBoot | PGliteReconnect = existingPgliteWorker
      ? { ...common, type: "RECONNECT_PGLITE", port: channel.port2 }
      : { ...common, port: channel.port2 };
    const pyReady = waitForBoot(pyodideWorker, bootId, "Pyodide");
    const pgReady = waitForBoot(pgliteWorker, bootId, "PGlite");
    pyodideWorker.postMessage({ ...common, port: channel.port1 }, [channel.port1]);
    pgliteWorker.postMessage(pgliteConnection, [channel.port2]);
    try {
      await Promise.all([pyReady, pgReady]);
    } catch (error) {
      const bootError = error instanceof Error ? error : new Error(String(error));
      this.disconnectPython(bootError);
      if (createdPgliteWorker) {
        pgliteWorker.terminate();
        if (this.pgliteWorker === pgliteWorker) this.pgliteWorker = undefined;
      }
      this.starting = undefined;
      throw error;
    }
  }

  private async restartWorkers(): Promise<void> {
    this.disconnectPython(new RuntimeClientError({ code: "RUNTIME_RESTARTED", message: "Runtime connection restarted" }));
    this.starting = undefined;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.starting = this.boot(Boolean(this.pgliteWorker));
        await this.starting;
        return;
      } catch (error) {
        lastError = error;
        this.starting = undefined;
        if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new RuntimeClientError({ code: "RUNTIME_RESTART_FAILED", message: "Runtime Workers could not be restarted" });
  }

  private readonly handlePythonMessage = (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (!isEnvelope(value) || !isRecord(value)) return;
    const pending = this.pending.get(value.requestId);
    if (!pending) return;
    this.pending.delete(value.requestId);
    if (value.type === "RESULT" && typeof value.value === "string") pending.resolve(value.value);
    else if (value.type === "ERROR" && isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") {
      pending.reject(new RuntimeClientError(value.error as RpcFault));
    } else pending.reject(new RuntimeClientError({ code: "RUNTIME_INVALID_RESPONSE", message: "Invalid Python Worker response" }));
  };

  private stop(error: Error): void {
    this.disconnectPython(error);
    this.pgliteWorker?.terminate();
    this.pgliteWorker = undefined;
  }

  private disconnectPython(error: Error): void {
    this.pyodideWorker?.terminate();
    this.pyodideWorker = undefined;
    this.markControlBroken();
    this.control = undefined;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private markControlBroken(): void {
    if (this.control) {
      Atomics.store(this.control, CONTROL.STATE, STATE.BROKEN);
      Atomics.notify(this.control, CONTROL.STATE);
    }
  }
}

export const runtimeClient = new RuntimeClient();
