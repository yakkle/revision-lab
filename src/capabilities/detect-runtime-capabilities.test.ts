import { describe, expect, it } from "vitest";
import {
  detectRuntimeCapabilities,
  type RuntimeProbeSource,
} from "./detect-runtime-capabilities";

const completeEnvironment: RuntimeProbeSource = {
  isSecureContext: true,
  crossOriginIsolated: true,
  SharedArrayBuffer,
  Worker: class WorkerStub {},
  WebAssembly,
  indexedDB: {},
};

describe("detectRuntimeCapabilities", () => {
  it("enables both modes when every browser capability is present", () => {
    const result = detectRuntimeCapabilities(completeEnvironment);

    expect(result.sqliteAvailable).toBe(true);
    expect(result.postgresqlAvailable).toBe(true);
    expect(result.postgresqlBlockers).toEqual([]);
  });

  it("keeps SQLite available when cross-origin isolation is missing", () => {
    const result = detectRuntimeCapabilities({
      ...completeEnvironment,
      crossOriginIsolated: false,
      SharedArrayBuffer: undefined,
    });

    expect(result.sqliteAvailable).toBe(true);
    expect(result.postgresqlAvailable).toBe(false);
    expect(result.postgresqlBlockers).toEqual(["Cross-origin isolation", "SharedArrayBuffer"]);
  });

  it("disables both modes when core worker capabilities are missing", () => {
    const result = detectRuntimeCapabilities({
      ...completeEnvironment,
      Worker: undefined,
      indexedDB: undefined,
    });

    expect(result.sqliteAvailable).toBe(false);
    expect(result.postgresqlAvailable).toBe(false);
    expect(result.postgresqlBlockers).toContain("Web Worker");
    expect(result.postgresqlBlockers).toContain("IndexedDB");
  });
});
