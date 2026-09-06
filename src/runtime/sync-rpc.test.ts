import { describe, expect, it } from "vitest";
import { CONTROL, CONTROL_BYTES, PROTOCOL_VERSION, RESPONSE_BYTES, STATE, rpcError, type PgQuery } from "./protocol";
import { SyncRpc, publishResponse } from "./sync-rpc";

function fixture(postMessage: (request: PgQuery, control: Int32Array, response: Uint8Array) => void, timeout = 20) {
  const control = new Int32Array(new SharedArrayBuffer(CONTROL_BYTES));
  const response = new Uint8Array(new SharedArrayBuffer(RESPONSE_BYTES));
  const port = { postMessage: (value: PgQuery) => postMessage(value, control, response) } as MessagePort;
  const rpc = new SyncRpc(port, control, response, { protocolVersion: PROTOCOL_VERSION, requestId: "test", workspaceId: "test" }, timeout);
  return { control, response, rpc };
}

describe("synchronous Worker RPC", () => {
  it("returns a matching response", () => {
    const { rpc } = fixture((request, control, response) => publishResponse(control, response, request.sequence, {
      ok: true,
      rows: [[{ tag: "number", value: 42 }]],
      fields: [{ name: "answer", dataTypeId: 23 }],
      rowCount: 1,
    }));
    expect(rpc.query("select 42", [])).toMatchObject({ ok: true, rowCount: 1 });
  });

  it("marks stale sequences as a protocol error", () => {
    const { rpc } = fixture((request, control, response) => {
      const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, rows: [], fields: [], rowCount: 0 }));
      response.set(bytes);
      Atomics.store(control, CONTROL.LENGTH, bytes.length);
      Atomics.store(control, CONTROL.RESPONSE_SEQUENCE, request.sequence + 1);
      Atomics.store(control, CONTROL.STATE, STATE.OK);
    });
    expect(rpc.query("select 1", [])).toMatchObject({ ok: false, error: { code: "RPC_PROTOCOL_ERROR" } });
    expect(rpc.query("select 1", [])).toEqual(rpcError("RPC_CONNECTION_BROKEN"));
  });

  it("returns stable errors for timeout and Worker termination", () => {
    expect(fixture(() => undefined, 1).rpc.query("select pg_sleep(20)", [])).toEqual(rpcError("RPC_TIMEOUT"));
    const terminated = fixture((_request, control) => Atomics.store(control, CONTROL.STATE, STATE.BROKEN));
    expect(terminated.rpc.query("select 1", [])).toEqual(rpcError("RPC_WORKER_TERMINATED"));
  });

  it("replaces an oversized response with a bounded error", () => {
    const { rpc } = fixture((request, control, response) => publishResponse(control, response, request.sequence, {
      ok: true,
      rows: [[{ tag: "string", value: "x".repeat(RESPONSE_BYTES) }]],
      fields: [{ name: "large", dataTypeId: 25 }],
      rowCount: 1,
    }));
    expect(rpc.query("select repeat('x', 9000000)", [])).toEqual(rpcError("RPC_RESPONSE_TOO_LARGE", `RPC response exceeds ${RESPONSE_BYTES} bytes`));
  });
});
