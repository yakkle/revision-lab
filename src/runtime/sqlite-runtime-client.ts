import { AlembicRuntimeClient } from "./alembic-runtime-client";

export { runtimeFault } from "./alembic-runtime-client";

export class SqliteRuntimeClient extends AlembicRuntimeClient {
  constructor(workspaceId?: string) {
    super("sqlite", workspaceId);
  }
}
