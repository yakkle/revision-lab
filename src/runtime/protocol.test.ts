import { describe, expect, it } from "vitest";
import { CONTROL_BYTES, PROTOCOL_VERSION, RESPONSE_BYTES, isPgQuery, isTaggedValue, isWorkerBoot } from "./protocol";

describe("runtime protocol validation", () => {
  it("accepts a complete query envelope and rejects lossy numbers", () => {
    expect(isPgQuery({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "request-1",
      workspaceId: "workspace_1",
      op: "QUERY",
      sequence: 1,
      sql: "select $1",
      params: [{ tag: "number", value: 7 }],
    })).toBe(true);
    expect(isTaggedValue({ tag: "number", value: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  });

  it("rejects traversal-like workspace identifiers and malformed buffers", () => {
    const channel = new MessageChannel();
    expect(isWorkerBoot({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "request-1",
      workspaceId: "../escape",
      type: "BOOT",
      port: channel.port1,
      control: new SharedArrayBuffer(CONTROL_BYTES),
      response: new SharedArrayBuffer(RESPONSE_BYTES),
      assetBase: location.href,
    })).toBe(false);
    channel.port1.close();
    channel.port2.close();
  });
});
