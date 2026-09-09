import { createStore } from "zustand/vanilla";
import { AlembicRuntimeClient, runtimeFault } from "../runtime/alembic-runtime-client";
import type { CommandResult, DatabaseMode, FileChange, RpcFault, TableData, WorkspaceState } from "../runtime/protocol";

export type Panel = "editor" | "graph" | "database" | "diff" | "logs";
export type Draft = { text: string; saved: string };
export type Entry = { id: number; command: string; result?: CommandResult; error?: RpcFault };
export type Workspace = {
  id: string; name: string; mode: DatabaseMode; snapshot?: WorkspaceState;
  drafts: Record<string, Draft>; file?: string; revision?: string; table?: string;
  data?: TableData; entries: Entry[]; changes: FileChange[]; result?: CommandResult;
  error?: RpcFault; broken: boolean; stale: boolean;
};
type LabState = { workspaces: Workspace[]; activeId?: string; busy: boolean; progress: string; panel: Panel };
export type LabClient = Pick<AlembicRuntimeClient, "createWorkspace" | "readFile" | "writeFile" | "runCommand" | "readTable" | "close" | "onProgress" | "onFailure">;
export type ClientFactory = (mode: DatabaseMode, id: string) => LabClient;

export function createLab(factory: ClientFactory = (mode, id) => new AlembicRuntimeClient(mode, id)) {
  const store = createStore<LabState>(() => ({ workspaces: [], busy: false, progress: "Workspace를 만들어 실습을 시작하세요.", panel: "editor" }));
  const clients = new Map<string, LabClient>();
  let entryId = 0;
  let workspaceNumber = 0;
  const active = () => store.getState().workspaces.find((item) => item.id === store.getState().activeId);
  const patch = (id: string, update: Partial<Workspace>) => store.setState((state) => ({ workspaces: state.workspaces.map((item) => item.id === id ? { ...item, ...update } : item) }));
  const fail = (id: string, error: unknown) => {
    const fault = runtimeFault(error);
    const broken = /TIMEOUT|WORKER_CRASH|RUNTIME_CLOSED|BOOT_FAILED|INVALID_RESPONSE/.test(fault.code);
    patch(id, { error: fault, broken: broken || Boolean(store.getState().workspaces.find((item) => item.id === id)?.broken), stale: true, data: undefined });
    return fault;
  };
  const perform = async (operation: (workspace: Workspace, client: LabClient) => Promise<void>) => {
    const workspace = active();
    if (!workspace || workspace.broken || store.getState().busy) return;
    const client = clients.get(workspace.id);
    if (!client) return;
    store.setState({ busy: true, progress: "요청 처리 중" });
    patch(workspace.id, { error: undefined });
    try { await operation(workspace, client); }
    catch (error) { fail(workspace.id, error); }
    finally { store.setState({ busy: false, progress: "요청 처리 완료" }); }
  };
  const loadFile = async (workspace: Workspace, client: LabClient, path: string, refresh = false) => {
    const current = active() ?? workspace;
    const draft = current.drafts[path];
    if (!draft || (refresh && draft.text === draft.saved)) {
      const content = await client.readFile(path);
      patch(workspace.id, { drafts: { ...current.drafts, [path]: { text: content, saved: content } }, file: path });
    } else patch(workspace.id, { file: path });
  };
  return {
    store,
    async create(mode: DatabaseMode) {
      if (store.getState().busy || clients.size >= 4) return;
      const id = `${mode}-${crypto.randomUUID()}`;
      const number = ++workspaceNumber;
      const client = factory(mode, id);
      clients.set(id, client);
      client.onProgress = (progress) => store.setState({ progress });
      client.onFailure = (fault) => patch(id, { error: fault, broken: true, stale: true, data: undefined });
      store.setState((state) => ({ activeId: id, workspaces: [...state.workspaces, {
        id, name: `${mode === "sqlite" ? "SQLite" : "PostgreSQL"} ${number}`,
        mode, drafts: {}, entries: [], changes: [], broken: false, stale: false,
      }] }));
      await perform(async () => { patch(id, { snapshot: await client.createWorkspace() }); });
    },
    select(id: string) { if (!store.getState().busy) store.setState({ activeId: id }); },
    async reset() {
      const workspace = active();
      if (!workspace || store.getState().busy) return;
      clients.get(workspace.id)?.close();
      clients.delete(workspace.id);
      store.setState((state) => ({ workspaces: state.workspaces.filter((item) => item.id !== workspace.id), activeId: undefined }));
      await this.create(workspace.mode);
    },
    panel(panel: Panel) { store.setState({ panel }); },
    edit(text: string) {
      const workspace = active();
      if (!workspace?.file || store.getState().busy || workspace.broken) return;
      const draft = workspace.drafts[workspace.file];
      if (draft) patch(workspace.id, { drafts: { ...workspace.drafts, [workspace.file]: { ...draft, text } } });
    },
    openFile(path: string) {
      store.setState({ panel: "editor" });
      return perform(async (workspace, client) => {
        const revision = workspace.snapshot?.revisions.find((node) => node.path === path)?.revision;
        patch(workspace.id, { revision });
        await loadFile(workspace, client, path);
      });
    },
    selectRevision(revision: string) {
      const workspace = active();
      const path = workspace?.snapshot?.revisions.find((node) => node.revision === revision)?.path;
      if (path) return this.openFile(path);
    },
    save() {
      return perform(async (workspace, client) => {
        const path = workspace.file;
        if (!path) return;
        const draft = workspace.drafts[path];
        if (!draft) return;
        const result = await client.writeFile(path, draft.text);
        patch(workspace.id, { snapshot: result.state, changes: result.fileChanges, stale: false, data: undefined,
          drafts: { ...workspace.drafts, [path]: { text: draft.text, saved: draft.text } } });
      });
    },
    run(command: string) {
      return perform(async (workspace, client) => {
        const id = ++entryId;
        try {
          const result = await client.runCommand(command);
          patch(workspace.id, { result, snapshot: result.after, changes: result.fileChanges, data: undefined, stale: false,
            error: result.error, entries: [...workspace.entries, { id, command, result }].slice(-100) });
          const path = result.fileChanges.find((file) => file.change !== "deleted" && result.after.revisions.some((node) => node.path === file.path))?.path
            ?? (workspace.file && result.after.files.includes(workspace.file) ? workspace.file : result.after.files.find((file) => file === "models.py"));
          if (path) {
            await loadFile(workspace, client, path, true);
            patch(workspace.id, { revision: result.after.revisions.find((node) => node.path === path)?.revision });
          } else patch(workspace.id, { file: undefined, revision: undefined });
        } catch (error) {
          const fault = fail(workspace.id, error);
          patch(workspace.id, { entries: [...workspace.entries, { id, command, error: fault }].slice(-100) });
        }
      });
    },
    table(table: string) {
      store.setState({ panel: "database" });
      return perform(async (workspace, client) => {
        patch(workspace.id, { table, data: undefined });
        patch(workspace.id, { data: await client.readTable(table) });
      });
    },
    dispose() { clients.forEach((client) => client.close()); clients.clear(); },
  };
}
export type Lab = ReturnType<typeof createLab>;
