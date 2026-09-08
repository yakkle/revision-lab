import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlembicRuntimeClient } from "./alembic-runtime-client";
import type { AlembicRuntimeRequest } from "./protocol";

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  requests: AlembicRuntimeRequest[] = [];
  terminate = vi.fn();

  constructor() {
    super();
    TestWorker.instances.push(this);
  }

  postMessage(request: AlembicRuntimeRequest | { type: "BOOT_SQLITE" }): void {
    if (request.type === "BOOT_SQLITE") {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { ...request, type: "READY" } })));
    } else this.requests.push(request);
  }

  respond(request: AlembicRuntimeRequest, workspaceId = request.workspaceId): void {
    this.dispatchEvent(new MessageEvent("message", { data: {
      ...request, workspaceId, type: "STATE_SNAPSHOT",
      state: { files: [], revisions: [], schema: { dialect: "sqlite", tables: [], alembicVersion: [] } },
    } }));
  }
}

beforeEach(() => {
  TestWorker.instances = [];
  vi.stubGlobal("Worker", TestWorker);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Alembic workspace client", () => {
  it("rejects overlapping requests and ignores replies for another workspace", async () => {
    const client = new AlembicRuntimeClient("sqlite", "workspace_1");
    await client.start();
    const first = client.inspect();
    await expect(client.inspect()).rejects.toMatchObject({ fault: { code: "RUNTIME_BUSY" } });
    const worker = TestWorker.instances[0]!;
    const request = worker.requests[0]!;
    worker.respond(request, "other_workspace");
    await expect(client.inspect()).rejects.toMatchObject({ fault: { code: "RUNTIME_BUSY" } });
    worker.respond(request);
    await expect(first).resolves.toMatchObject({ schema: { dialect: "sqlite" } });
    client.close();
  });

  it("terminates a timed-out command and never silently creates an empty replacement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = new AlembicRuntimeClient("sqlite");
    await client.start();
    const result = client.runAlembic(["upgrade", "head"]);
    const rejected = expect(result).rejects.toMatchObject({ fault: { code: "ALEMBIC_COMMAND_TIMEOUT" } });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    await expect(client.inspect()).rejects.toMatchObject({ fault: { code: "ALEMBIC_COMMAND_TIMEOUT" } });
    expect(TestWorker.instances).toHaveLength(1);
  });

  it("surfaces Worker crashes to the in-flight request", async () => {
    const client = new AlembicRuntimeClient("sqlite");
    await client.start();
    const result = client.inspect();
    await Promise.resolve();
    const rejected = expect(result).rejects.toMatchObject({ fault: { code: "RUNTIME_WORKER_CRASH", message: "Worker failed" } });
    TestWorker.instances[0]!.dispatchEvent(new ErrorEvent("error", { message: "Worker failed" }));
    await rejected;
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
});
