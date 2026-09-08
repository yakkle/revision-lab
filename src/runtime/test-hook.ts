import { runtimeClient } from "./runtime-client";
import { SqliteRuntimeClient } from "./sqlite-runtime-client";
import { AlembicRuntimeClient } from "./alembic-runtime-client";

const sqliteRuntime = new SqliteRuntimeClient();

declare global {
  interface Window {
    __revisionLabT2?: {
      query: typeof runtimeClient.query;
      probe: typeof runtimeClient.runTechnicalProbe;
      restart: typeof runtimeClient.restart;
      close: typeof runtimeClient.close;
    };
    __revisionLabT3?: {
      workspaceId: string;
      createWorkspace: typeof sqliteRuntime.createWorkspace;
      runAlembic: typeof sqliteRuntime.runAlembic;
      readFile: typeof sqliteRuntime.readFile;
      writeFile: typeof sqliteRuntime.writeFile;
      inspect: typeof sqliteRuntime.inspect;
      close: typeof sqliteRuntime.close;
    };
    __revisionLabT4?: {
      probe: typeof runtimeClient.runDbapiProbe;
      restart: typeof runtimeClient.restart;
      close: typeof runtimeClient.close;
    };
    __revisionLabT5?: Window["__revisionLabT3"];
  }
}

if (import.meta.env.VITE_T5_TEST_HOOK === "1") {
  const postgresqlRuntime = new AlembicRuntimeClient("postgresql");
  window.__revisionLabT5 = {
    workspaceId: postgresqlRuntime.workspaceId,
    createWorkspace: postgresqlRuntime.createWorkspace.bind(postgresqlRuntime),
    runAlembic: postgresqlRuntime.runAlembic.bind(postgresqlRuntime),
    readFile: postgresqlRuntime.readFile.bind(postgresqlRuntime),
    writeFile: postgresqlRuntime.writeFile.bind(postgresqlRuntime),
    inspect: postgresqlRuntime.inspect.bind(postgresqlRuntime),
    close: postgresqlRuntime.close.bind(postgresqlRuntime),
  };
}

if (import.meta.env.VITE_T3_TEST_HOOK === "1") {
  window.__revisionLabT3 = {
    workspaceId: sqliteRuntime.workspaceId,
    createWorkspace: sqliteRuntime.createWorkspace.bind(sqliteRuntime),
    runAlembic: sqliteRuntime.runAlembic.bind(sqliteRuntime),
    readFile: sqliteRuntime.readFile.bind(sqliteRuntime),
    writeFile: sqliteRuntime.writeFile.bind(sqliteRuntime),
    inspect: sqliteRuntime.inspect.bind(sqliteRuntime),
    close: sqliteRuntime.close.bind(sqliteRuntime),
  };
}

if (import.meta.env.VITE_T2_TEST_HOOK === "1") {
  window.__revisionLabT2 = {
    query: runtimeClient.query.bind(runtimeClient),
    probe: runtimeClient.runTechnicalProbe.bind(runtimeClient),
    restart: runtimeClient.restart.bind(runtimeClient),
    close: runtimeClient.close.bind(runtimeClient),
  };
}

if (import.meta.env.VITE_T4_TEST_HOOK === "1") {
  window.__revisionLabT4 = {
    probe: runtimeClient.runDbapiProbe.bind(runtimeClient),
    restart: runtimeClient.restart.bind(runtimeClient),
    close: runtimeClient.close.bind(runtimeClient),
  };
}
