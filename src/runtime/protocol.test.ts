import { describe, expect, it } from "vitest";
import {
  CONTROL_BYTES, PROTOCOL_VERSION, RESPONSE_BYTES, isPGliteReconnect, isPgQuery, isPgRequest, isSqliteRuntimeRequest,
  isTaggedValue, isWorkerBoot, isAlembicRuntimeReply,
} from "./protocol";

describe("runtime protocol validation", () => {
  it("validates command text, progress and bounded tagged table rows", () => {
    const envelope = { protocolVersion: 1, requestId: "ui-1", workspaceId: "lab_1" };
    expect(isSqliteRuntimeRequest({ ...envelope, type: "RUN_COMMAND", command: "alembic heads" })).toBe(true);
    expect(isSqliteRuntimeRequest({ ...envelope, type: "RUN_COMMAND", command: " " })).toBe(false);
    expect(isSqliteRuntimeRequest({ ...envelope, type: "RUN_COMMAND", command: "x".repeat(8193) })).toBe(false);
    expect(isSqliteRuntimeRequest({ ...envelope, type: "READ_TABLE", table: "users" })).toBe(true);
    expect(isSqliteRuntimeRequest({ ...envelope, type: "READ_TABLE", table: 1 })).toBe(false);
    expect(isAlembicRuntimeReply({ ...envelope, type: "PROGRESS", message: "loading" })).toBe(true);
    const data = { table: "users", columns: ["id"], rows: [[{ tag: "bigint", value: "9007199254740993" }]], truncated: false };
    expect(isAlembicRuntimeReply({ ...envelope, type: "TABLE_DATA", data })).toBe(true);
    expect(isAlembicRuntimeReply({ ...envelope, type: "TABLE_DATA", data: { ...data, rows: [[{ tag: "number", value: 9007199254740992 }]] } })).toBe(false);
    expect(isAlembicRuntimeReply({ ...envelope, type: "TABLE_DATA", data: { ...data, columns: [] } })).toBe(false);
  });
  it("accepts both database snapshots and rejects an unknown dialect", () => {
    const envelope = { protocolVersion: PROTOCOL_VERSION, requestId: "snapshot-1", workspaceId: "lab_1", type: "STATE_SNAPSHOT" };
    for (const dialect of ["sqlite", "postgresql", "mysql"]) {
      expect(isAlembicRuntimeReply({ ...envelope, state: {
        files: [], revisions: [], schema: { dialect, tables: [], alembicVersion: ["a1", "b1"] },
      } })).toBe(dialect !== "mysql");
    }
  });
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
