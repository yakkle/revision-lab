export type CapabilityKey =
  | "secureContext"
  | "crossOriginIsolated"
  | "sharedArrayBuffer"
  | "worker"
  | "webAssembly"
  | "indexedDb";

export type CapabilityCheck = {
  key: CapabilityKey;
  label: string;
  supported: boolean;
  description: string;
};

export type RuntimeCapabilities = {
  checks: CapabilityCheck[];
  sqliteAvailable: boolean;
  postgresqlAvailable: boolean;
  postgresqlBlockers: string[];
};

export type RuntimeProbeSource = {
  isSecureContext?: boolean;
  crossOriginIsolated?: boolean;
  SharedArrayBuffer?: unknown;
  Worker?: unknown;
  WebAssembly?: unknown;
  indexedDB?: unknown;
};

const labels: Record<CapabilityKey, Pick<CapabilityCheck, "label" | "description">> = {
  secureContext: {
    label: "보안 컨텍스트",
    description: "HTTPS 또는 localhost에서 실행 중인지 확인합니다.",
  },
  crossOriginIsolated: {
    label: "Cross-origin isolation",
    description: "COOP/COEP 응답 헤더가 적용됐는지 확인합니다.",
  },
  sharedArrayBuffer: {
    label: "SharedArrayBuffer",
    description: "동기 DBAPI Worker RPC에 필요한 공유 메모리를 확인합니다.",
  },
  worker: {
    label: "Web Worker",
    description: "Python과 PostgreSQL을 UI thread 밖에서 실행할 수 있는지 확인합니다.",
  },
  webAssembly: {
    label: "WebAssembly",
    description: "Pyodide와 PGlite WASM runtime을 실행할 수 있는지 확인합니다.",
  },
  indexedDb: {
    label: "IndexedDB",
    description: "workspace와 DB checkpoint를 브라우저에 저장할 수 있는지 확인합니다.",
  },
};

const createCheck = (key: CapabilityKey, supported: boolean): CapabilityCheck => ({
  key,
  supported,
  ...labels[key],
});

export function detectRuntimeCapabilities(
  source: RuntimeProbeSource = globalThis as RuntimeProbeSource,
): RuntimeCapabilities {
  const checks = [
    createCheck("secureContext", source.isSecureContext === true),
    createCheck("crossOriginIsolated", source.crossOriginIsolated === true),
    createCheck("sharedArrayBuffer", typeof source.SharedArrayBuffer === "function"),
    createCheck("worker", typeof source.Worker === "function"),
    createCheck("webAssembly", typeof source.WebAssembly === "object"),
    createCheck("indexedDb", typeof source.indexedDB === "object"),
  ];

  const byKey = Object.fromEntries(checks.map((check) => [check.key, check.supported])) as Record<
    CapabilityKey,
    boolean
  >;
  const sqliteAvailable = byKey.worker && byKey.webAssembly && byKey.indexedDb;
  const postgresqlRequired: CapabilityKey[] = [
    "secureContext",
    "crossOriginIsolated",
    "sharedArrayBuffer",
    "worker",
    "webAssembly",
    "indexedDb",
  ];
  const postgresqlBlockers = postgresqlRequired
    .filter((key) => !byKey[key])
    .map((key) => labels[key].label);

  return {
    checks,
    sqliteAvailable,
    postgresqlAvailable: postgresqlBlockers.length === 0,
    postgresqlBlockers,
  };
}
