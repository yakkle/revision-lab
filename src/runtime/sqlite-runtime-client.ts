import {
  PROTOCOL_VERSION, isEnvelope, isRecord, isSqliteRuntimeReply,
  type CommandResult, type FileChange, type RpcFault, type SqliteRuntimeReply, type SqliteWorkerBoot, type WorkspaceState,
} from "./protocol";
import { RuntimeClientError } from "./runtime-client";

type RequestBody =
  | { type: "CREATE_WORKSPACE" }
  | { type: "RUN_ALEMBIC"; argv: string[] }
  | { type: "READ_FILE"; path: string }
  | { type: "WRITE_FILE"; path: string; content: string }
  | { type: "INSPECT" };

type PendingRequest = {
  resolve: (reply: SqliteRuntimeReply) => void;
  reject: (error: Error) => void;
  timeout: number;
};

function waitForBoot(worker: Worker, requestId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (error) reject(error); else resolve();
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (!isEnvelope(value) || value.requestId !== requestId) return;
      if (!isSqliteRuntimeReply(value)) {
        finish(new RuntimeClientError({ code: "RUNTIME_INVALID_RESPONSE", message: "Invalid SQLite boot response" }));
        return;
      }
      if (value.type === "READY") finish();
      else if (value.type === "ERROR") finish(new RuntimeClientError(value.error));
    };
    const onError = (event: ErrorEvent) => finish(new RuntimeClientError({ code: "RUNTIME_WORKER_CRASH", message: event.message }));
    const timeout = window.setTimeout(
      () => finish(new RuntimeClientError({ code: "SQLITE_BOOT_TIMEOUT", message: "SQLite runtime boot exceeded 90 seconds" })),
      90_000,
    );
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

export class SqliteRuntimeClient {
  private worker?: Worker;
  private starting?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(readonly workspaceId = `sqlite-${crypto.randomUUID()}`) {}

  start(): Promise<void> {
    this.starting ??= this.boot();
    return this.starting;
  }

  async createWorkspace(): Promise<WorkspaceState> {
    const reply = await this.request({ type: "CREATE_WORKSPACE" });
    if (reply.type !== "WORKSPACE_CREATED") throw this.invalidReply(reply);
    return reply.state;
  }

  async runAlembic(argv: string[]): Promise<CommandResult> {
    const reply = await this.request({ type: "RUN_ALEMBIC", argv }, 30_000);
    if (reply.type !== "COMMAND_RESULT") throw this.invalidReply(reply);
    return reply.result;
  }

  async readFile(path: string): Promise<string> {
    const reply = await this.request({ type: "READ_FILE", path });
    if (reply.type !== "FILE_CONTENT") throw this.invalidReply(reply);
    return reply.content;
  }

  async writeFile(path: string, content: string): Promise<{ state: WorkspaceState; fileChanges: FileChange[] }> {
    const reply = await this.request({ type: "WRITE_FILE", path, content });
    if (reply.type !== "FILE_WRITTEN") throw this.invalidReply(reply);
    return { state: reply.state, fileChanges: reply.fileChanges };
  }

  async inspect(): Promise<WorkspaceState> {
    const reply = await this.request({ type: "INSPECT" });
    if (reply.type !== "STATE_SNAPSHOT") throw this.invalidReply(reply);
    return reply.state;
  }

  close(): void {
    this.stop(new RuntimeClientError({ code: "RUNTIME_CLOSED", message: "SQLite runtime closed" }));
    this.starting = undefined;
  }

  private async boot(): Promise<void> {
    const worker = new Worker(new URL("./pyodide.worker.ts", import.meta.url), { type: "module", name: "revision-lab-sqlite" });
    this.worker = worker;
    worker.addEventListener("message", this.handleMessage);
    worker.addEventListener("error", this.handleCrash);
    const requestId = crypto.randomUUID();
    const boot: SqliteWorkerBoot = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      workspaceId: this.workspaceId,
      type: "BOOT_SQLITE",
      assetBase: new URL(`${import.meta.env.BASE_URL}runtime/`, location.href).href,
    };
    try {
      const ready = waitForBoot(worker, requestId);
      worker.postMessage(boot);
      await ready;
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
      this.starting = undefined;
      throw error;
    }
  }

  private async request(body: RequestBody, timeoutMs = 15_000): Promise<SqliteRuntimeReply> {
    await this.start();
    const worker = this.worker;
    if (!worker) throw new RuntimeClientError({ code: "RUNTIME_NOT_READY", message: "SQLite runtime is not ready" });
    const requestId = crypto.randomUUID();
    const request = { protocolVersion: PROTOCOL_VERSION, requestId, workspaceId: this.workspaceId, ...body };
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        const error = new RuntimeClientError({
          code: body.type === "RUN_ALEMBIC" ? "ALEMBIC_COMMAND_TIMEOUT" : "SQLITE_REQUEST_TIMEOUT",
          message: `${body.type} exceeded ${timeoutMs} ms`,
        });
        this.stop(error);
        this.starting = undefined;
        reject(error);
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      worker.postMessage(request);
    });
  }

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (!isEnvelope(value)) return;
    const pending = this.pending.get(value.requestId);
    if (!pending) return;
    this.pending.delete(value.requestId);
    window.clearTimeout(pending.timeout);
    if (!isSqliteRuntimeReply(value)) {
      pending.reject(new RuntimeClientError({ code: "RUNTIME_INVALID_RESPONSE", message: "Invalid SQLite runtime response" }));
      return;
    }
    if (value.type === "ERROR") pending.reject(new RuntimeClientError(value.error));
    else pending.resolve(value);
  };

  private readonly handleCrash = (event: ErrorEvent) => {
    this.stop(new RuntimeClientError({ code: "RUNTIME_WORKER_CRASH", message: event.message }));
    this.starting = undefined;
  };

  private invalidReply(reply: SqliteRuntimeReply): RuntimeClientError {
    const type = isEnvelope(reply) && isRecord(reply) ? String(reply.type) : "unknown";
    return new RuntimeClientError({ code: "RUNTIME_INVALID_RESPONSE", message: `Unexpected SQLite response: ${type}` });
  }

  private stop(error: Error): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function runtimeFault(error: unknown): RpcFault {
  return error instanceof RuntimeClientError
    ? error.fault
    : { code: "SQLITE_CLIENT_ERROR", message: error instanceof Error ? error.message : String(error) };
}
