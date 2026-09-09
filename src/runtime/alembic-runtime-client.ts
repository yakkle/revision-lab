import {
  CONTROL, CONTROL_BYTES, PROTOCOL_VERSION, RESPONSE_BYTES, STATE, isEnvelope, isRecord, isAlembicRuntimeReply,
  type CommandResult, type DatabaseMode, type FileChange, type RpcFault, type AlembicRuntimeReply, type SqliteWorkerBoot, type WorkerBoot, type WorkspaceState,
} from "./protocol";
import { RuntimeClientError } from "./runtime-client";

type RequestBody =
  | { type: "RUN_COMMAND"; command: string }
  | { type: "READ_TABLE"; table: string }
  | { type: "CREATE_WORKSPACE" }
  | { type: "RUN_ALEMBIC"; argv: string[] }
  | { type: "READ_FILE"; path: string }
  | { type: "WRITE_FILE"; path: string; content: string }
  | { type: "INSPECT" };

type PendingRequest = {
  resolve: (reply: AlembicRuntimeReply) => void;
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
      if (!isAlembicRuntimeReply(value)) {
        finish(new RuntimeClientError({ code: "RUNTIME_INVALID_RESPONSE", message: "Invalid Alembic boot response" }));
        return;
      }
      if (value.type === "READY") finish();
      else if (value.type === "ERROR") finish(new RuntimeClientError(value.error));
    };
    const onError = (event: ErrorEvent) => finish(new RuntimeClientError({ code: "RUNTIME_WORKER_CRASH", message: event.message }));
    const timeout = window.setTimeout(
      () => finish(new RuntimeClientError({ code: "RUNTIME_BOOT_TIMEOUT", message: "Alembic runtime boot exceeded 90 seconds" })),
      90_000,
    );
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

export class AlembicRuntimeClient {
  onProgress?: (message: string) => void;
  onFailure?: (fault: RpcFault) => void;
  private worker?: Worker;
  private pgliteWorker?: Worker;
  private control?: Int32Array;
  private starting?: Promise<void>;
  private terminalError?: Error;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(readonly mode: DatabaseMode, readonly workspaceId = `${mode}-${crypto.randomUUID()}`) {}

  start(): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
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

  async runCommand(command: string): Promise<CommandResult> {
    const reply = await this.request({ type: "RUN_COMMAND", command }, 30_000);
    if (reply.type !== "COMMAND_RESULT") throw this.invalidReply(reply);
    return reply.result;
  }

  async readTable(table: string) {
    const reply = await this.request({ type: "READ_TABLE", table });
    if (reply.type !== "TABLE_DATA") throw this.invalidReply(reply);
    return reply.data;
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
    this.stop(new RuntimeClientError({ code: "RUNTIME_CLOSED", message: "Alembic runtime closed" }));
    this.starting = undefined;
  }

  private async boot(): Promise<void> {
    if (this.mode === "postgresql" && (!crossOriginIsolated || typeof SharedArrayBuffer === "undefined")) {
      throw new RuntimeClientError({ code: "POSTGRESQL_UNAVAILABLE", message: "PostgreSQL requires cross-origin isolation and SharedArrayBuffer" });
    }
    const requestId = crypto.randomUUID();
    const worker = new Worker(new URL("./pyodide.worker.ts", import.meta.url), { type: "module", name: `revision-lab-${this.mode}` });
    this.worker = worker;
    worker.addEventListener("message", this.handleMessage);
    worker.addEventListener("error", this.handleCrash);
    worker.addEventListener("messageerror", this.handleMessageError);
    const boot: SqliteWorkerBoot = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      workspaceId: this.workspaceId,
      type: "BOOT_SQLITE",
      assetBase: new URL(`${import.meta.env.BASE_URL}runtime/`, location.href).href,
    };
    try {
      const ready = waitForBoot(worker, requestId);
      if (this.mode === "postgresql") {
        const channel = new MessageChannel();
        const control = new SharedArrayBuffer(CONTROL_BYTES);
        const response = new SharedArrayBuffer(RESPONSE_BYTES);
        this.control = new Int32Array(control);
        const pglite = new Worker(new URL("./pglite.worker.ts", import.meta.url), { type: "module", name: "revision-lab-alembic-pglite" });
        this.pgliteWorker = pglite;
        pglite.addEventListener("error", this.handleCrash);
        pglite.addEventListener("messageerror", this.handleMessageError);
        const pgReady = waitForBoot(pglite, requestId);
        const common = { ...boot, type: "BOOT", runtime: "alembic", control, response } satisfies Omit<WorkerBoot, "port">;
        worker.postMessage({ ...common, port: channel.port1 }, [channel.port1]);
        pglite.postMessage({ ...common, port: channel.port2 }, [channel.port2]);
        await Promise.all([ready, pgReady]);
      } else {
        worker.postMessage(boot);
        await ready;
      }
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
      this.starting = undefined;
      throw error;
    }
  }

  private async request(body: RequestBody, timeoutMs = 15_000): Promise<AlembicRuntimeReply> {
    await this.start();
    if (this.pending.size > 0) throw new RuntimeClientError({ code: "RUNTIME_BUSY", message: "A workspace request is already running" });
    const worker = this.worker;
    if (!worker) throw new RuntimeClientError({ code: "RUNTIME_NOT_READY", message: "Alembic runtime is not ready" });
    const requestId = crypto.randomUUID();
    const request = { protocolVersion: PROTOCOL_VERSION, requestId, workspaceId: this.workspaceId, ...body };
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        const error = new RuntimeClientError({
          code: body.type === "RUN_ALEMBIC" || body.type === "RUN_COMMAND" ? "ALEMBIC_COMMAND_TIMEOUT" : "RUNTIME_REQUEST_TIMEOUT",
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
    if (!isEnvelope(value) || value.workspaceId !== this.workspaceId) return;
    if (isAlembicRuntimeReply(value) && value.type === "PROGRESS") {
      this.onProgress?.(value.message);
      return;
    }
    const pending = this.pending.get(value.requestId);
    if (!pending) return;
    this.pending.delete(value.requestId);
    window.clearTimeout(pending.timeout);
    if (!isAlembicRuntimeReply(value)) {
      pending.reject(new RuntimeClientError({ code: "RUNTIME_INVALID_RESPONSE", message: "Invalid Alembic runtime response" }));
      return;
    }
    if (value.type === "ERROR") pending.reject(new RuntimeClientError(value.error));
    else pending.resolve(value);
  };

  private readonly handleCrash = (event: ErrorEvent) => {
    this.stop(new RuntimeClientError({ code: "RUNTIME_WORKER_CRASH", message: event.message }));
    this.starting = undefined;
  };

  private readonly handleMessageError = () => {
    this.stop(new RuntimeClientError({ code: "RUNTIME_WORKER_CRASH", message: "Worker message could not be decoded" }));
  };

  private invalidReply(reply: AlembicRuntimeReply): RuntimeClientError {
    const type = isEnvelope(reply) && isRecord(reply) ? String(reply.type) : "unknown";
    return new RuntimeClientError({ code: "RUNTIME_INVALID_RESPONSE", message: `Unexpected Alembic response: ${type}` });
  }

  private stop(error: Error): void {
    this.terminalError = error;
    if (this.control) {
      Atomics.store(this.control, CONTROL.STATE, STATE.BROKEN);
      Atomics.notify(this.control, CONTROL.STATE);
    }
    this.worker?.terminate();
    this.worker = undefined;
    this.pgliteWorker?.terminate();
    this.pgliteWorker = undefined;
    this.control = undefined;
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    const fault = runtimeFault(error);
    if (fault.code !== "RUNTIME_CLOSED") this.onFailure?.(fault);
  }
}

export function runtimeFault(error: unknown): RpcFault {
  return error instanceof RuntimeClientError
    ? error.fault
    : { code: "RUNTIME_CLIENT_ERROR", message: error instanceof Error ? error.message : String(error) };
}
