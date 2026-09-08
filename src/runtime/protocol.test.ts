import { describe, expect, it } from "vitest";
import {
  CONTROL_BYTES, PROTOCOL_VERSION, RESPONSE_BYTES, isPGliteReconnect, isPgQuery, isPgRequest, isSqliteRuntimeRequest,
  isTaggedValue, isWorkerBoot,
} from "./protocol";

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

  it("validates execute-many parameter sets", () => {
    const envelope = { protocolVersion: PROTOCOL_VERSION, requestId: "request-2", workspaceId: "workspace_1" };
    expect(isPgRequest({
      ...envelope,
      op: "EXECUTE_MANY",
      sequence: 2,
      sql: "insert into items values ($1)",
      paramSets: [[{ tag: "number", value: 1 }], [{ tag: "number", value: 2 }]],
    })).toBe(true);
    expect(isPgRequest({ ...envelope, op: "EXECUTE_MANY", sequence: 2, sql: "select 1", paramSets: ["invalid"] })).toBe(false);
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

  it("validates a PGlite reconnect with fresh RPC buffers", () => {
    const channel = new MessageChannel();
    expect(isPGliteReconnect({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "request-2",
      workspaceId: "workspace_1",
      type: "RECONNECT_PGLITE",
      port: channel.port1,
      control: new SharedArrayBuffer(CONTROL_BYTES),
      response: new SharedArrayBuffer(RESPONSE_BYTES),
      assetBase: location.href,
    })).toBe(true);
    channel.port1.close();
    channel.port2.close();
  });

  it("validates structured SQLite runtime requests before they reach Python", () => {
    const envelope = { protocolVersion: PROTOCOL_VERSION, requestId: "request-1", workspaceId: "sqlite_1" };
    expect(isSqliteRuntimeRequest({ ...envelope, type: "RUN_ALEMBIC", argv: ["upgrade", "head"] })).toBe(true);
    expect(isSqliteRuntimeRequest({ ...envelope, type: "RUN_ALEMBIC", argv: "upgrade head" })).toBe(false);
    expect(isSqliteRuntimeRequest({ ...envelope, type: "WRITE_FILE", path: "../escape.py", content: "pass" })).toBe(false);
    expect(isSqliteRuntimeRequest({ ...envelope, type: "WRITE_FILE", path: "models.py", content: "x".repeat(1024 * 1024 + 1) })).toBe(false);
  });
});
