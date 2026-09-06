import { runtimeClient } from "./runtime-client";

declare global {
  interface Window {
    __revisionLabT2?: {
      query: typeof runtimeClient.query;
      probe: typeof runtimeClient.runTechnicalProbe;
      restart: typeof runtimeClient.restart;
      close: typeof runtimeClient.close;
    };
  }
}

if (import.meta.env.VITE_T2_TEST_HOOK === "1") {
  window.__revisionLabT2 = {
    query: runtimeClient.query.bind(runtimeClient),
    probe: runtimeClient.runTechnicalProbe.bind(runtimeClient),
    restart: runtimeClient.restart.bind(runtimeClient),
    close: runtimeClient.close.bind(runtimeClient),
  };
}
