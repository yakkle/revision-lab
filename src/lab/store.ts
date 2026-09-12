import { createStore } from "zustand/vanilla";
import { AlembicRuntimeClient, runtimeFault } from "../runtime/alembic-runtime-client";
import type { CommandResult, DatabaseMode, FileChange, RpcFault, RuntimeCloneSeed, TableData, WorkspaceState } from "../runtime/protocol";
import {
  canCloneCollaborationBase, emptyLessonEvidence, recordCommandEvidence, recordRevisionReview,
  type LessonEvidence, type LessonId,
} from "../lessons/lessons";

export type Panel = "editor" | "graph" | "database" | "diff" | "logs";
export type Draft = { text: string; saved: string };
export type Entry = { id: number; command: string; result?: CommandResult; error?: RpcFault };
export type Workspace = {
  id: string; name: string; mode: DatabaseMode; snapshot?: WorkspaceState;
  drafts: Record<string, Draft>; file?: string; revision?: string; table?: string;
  data?: TableData; entries: Entry[]; changes: FileChange[]; result?: CommandResult;
  error?: RpcFault; broken: boolean; stale: boolean;
  evidence: LessonEvidence; role?: "base" | "alice" | "bob" | "integration"; collaborationId?: string;
};
export type Collaboration = {
  id: string; baseId: string; baseRevisions: string[]; aliceId: string; bobId: string; integrationId: string;
  filesIntegrated: boolean; multipleHeadsObserved: boolean;
};
type LabState = {
  workspaces: Workspace[]; activeId?: string; busy: boolean; progress: string; panel: Panel;
  guideEnabled: boolean; activeLesson: LessonId; collaboration?: Collaboration;
};
export type LabClient = Pick<AlembicRuntimeClient, "createWorkspace" | "exportClone" | "readFile" | "writeFile" | "runCommand" | "readTable" | "close" | "onProgress" | "onFailure">;
export type ClientFactory = (mode: DatabaseMode, id: string, seed?: RuntimeCloneSeed) => LabClient;

export function createLab(factory: ClientFactory = (mode, id, seed) => new AlembicRuntimeClient(mode, id, seed)) {
  const store = createStore<LabState>(() => ({
    workspaces: [], busy: false, progress: "Workspace를 만들어 실습을 시작하세요.", panel: "editor",
    guideEnabled: false, activeLesson: "init",
  }));
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
        mode, drafts: {}, entries: [], changes: [], broken: false, stale: false, evidence: emptyLessonEvidence(),
      }] }));
      await perform(async () => { patch(id, { snapshot: await client.createWorkspace() }); });
    },
    select(id: string) { if (!store.getState().busy) store.setState({ activeId: id }); },
    async reset() {
      const workspace = active();
      if (!workspace || store.getState().busy) return;
      const collaboration = store.getState().collaboration;
      const linked = collaboration && [collaboration.baseId, collaboration.aliceId, collaboration.bobId, collaboration.integrationId].includes(workspace.id)
        ? new Set([collaboration.baseId, collaboration.aliceId, collaboration.bobId, collaboration.integrationId])
        : new Set([workspace.id]);
      for (const id of linked) { clients.get(id)?.close(); clients.delete(id); }
      store.setState((state) => ({ workspaces: state.workspaces.filter((item) => !linked.has(item.id)), activeId: undefined,
        collaboration: linked.size > 1 ? undefined : state.collaboration }));
      await this.create(workspace.mode);
    },
    guide(enabled: boolean) { store.setState({ guideEnabled: enabled }); },
    lesson(lesson: LessonId) { store.setState({ activeLesson: lesson, guideEnabled: true }); },
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
        patch(workspace.id, { revision, evidence: recordRevisionReview(workspace.evidence, revision) });
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
            error: result.error, evidence: recordCommandEvidence(workspace.evidence, result),
            entries: [...workspace.entries, { id, command, result }].slice(-100) });
          const path = result.fileChanges.find((file) => file.change !== "deleted" && result.after.revisions.some((node) => node.path === file.path))?.path
            ?? (workspace.file && result.after.files.includes(workspace.file) ? workspace.file : result.after.files.find((file) => file === "models.py"));
          if (path) {
            await loadFile(workspace, client, path, true);
            const revision = result.after.revisions.find((node) => node.path === path)?.revision;
            const latest = store.getState().workspaces.find((item) => item.id === workspace.id);
            patch(workspace.id, { revision, evidence: recordRevisionReview(latest?.evidence ?? workspace.evidence, revision) });
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
    async setupCollaboration() {
      const source = active();
      if (!source || store.getState().busy || store.getState().collaboration) return;
      const sourceClient = clients.get(source.id);
      const dirty = Object.values(source.drafts).some((draft) => draft.text !== draft.saved);
      if (!sourceClient || clients.size !== 1 || dirty || !canCloneCollaborationBase(source.snapshot)) {
        patch(source.id, { error: { code: "COLLABORATION_BASE_NOT_READY", message: "하나의 workspace에서 저장하지 않은 편집 없이, 하나의 head까지 upgrade한 상태를 공통 base로 준비하세요." } });
        return;
      }
      store.setState({ busy: true, progress: "공통 base의 파일과 실제 DB를 복제하는 중" });
      const created: Array<{ id: string; client: LabClient }> = [];
      try {
        const seed = await sourceClient.exportClone();
        const collaborationId = `collab-${crypto.randomUUID()}`;
        const roles = [
          { role: "alice" as const, name: "Alice branch" },
          { role: "bob" as const, name: "Bob branch" },
          { role: "integration" as const, name: "Integration" },
        ];
        const clones: Workspace[] = [];
        for (const item of roles) {
          const id = `${source.mode}-${item.role}-${crypto.randomUUID()}`;
          const client = factory(source.mode, id, seed);
          created.push({ id, client });
          clients.set(id, client);
          client.onProgress = (progress) => store.setState({ progress: `${item.name} · ${progress}` });
          client.onFailure = (fault) => patch(id, { error: fault, broken: true, stale: true, data: undefined });
          clones.push({ id, name: item.name, mode: source.mode, drafts: {}, entries: [], changes: [], broken: false, stale: false,
            evidence: emptyLessonEvidence(), role: item.role, collaborationId, snapshot: await client.createWorkspace() });
        }
        const [alice, bob, integration] = clones;
        if (!alice || !bob || !integration) throw new Error("Collaboration clone creation failed");
        patch(source.id, { name: "공통 Base", role: "base", collaborationId, error: undefined });
        store.setState((state) => ({
          workspaces: [...state.workspaces, ...clones], activeId: alice.id,
          collaboration: { id: collaborationId, baseId: source.id, baseRevisions: source.snapshot!.revisions.map((revision) => revision.revision),
            aliceId: alice.id, bobId: bob.id, integrationId: integration.id, filesIntegrated: false, multipleHeadsObserved: false },
        }));
      } catch (error) {
        for (const item of created) { item.client.close(); clients.delete(item.id); }
        patch(source.id, { error: runtimeFault(error) });
      } finally {
        store.setState({ busy: false, progress: "협업 workspace 준비 완료" });
      }
    },
    async integrateBranches() {
      const collaboration = store.getState().collaboration;
      if (!collaboration || store.getState().busy || collaboration.filesIntegrated) return;
      const state = store.getState();
      const alice = state.workspaces.find((workspace) => workspace.id === collaboration.aliceId);
      const bob = state.workspaces.find((workspace) => workspace.id === collaboration.bobId);
      const integration = state.workspaces.find((workspace) => workspace.id === collaboration.integrationId);
      const integrationClient = clients.get(collaboration.integrationId);
      const base = new Set(collaboration.baseRevisions);
      const actorBranchFiles = [alice, bob].map((actor) => actor?.snapshot?.revisions
        .filter((revision) => !base.has(revision.revision) && revision.path)
        .map((revision) => ({ actor: actor!, path: revision.path! })) ?? []);
      const branchFiles = actorBranchFiles.flat();
      if (!alice || !bob || !integration || !integrationClient ||
        [alice, bob].some((actor) => Object.values(actor.drafts).some((draft) => draft.text !== draft.saved)) ||
        actorBranchFiles.some((files) => files.length === 0)) {
        if (integration) patch(integration.id, { error: { code: "BRANCHES_NOT_READY", message: "Alice와 Bob이 각자 revision을 만들고 편집을 저장한 뒤 PR을 합치세요." } });
        return;
      }
      if (new Set(branchFiles.map((item) => item.path)).size !== branchFiles.length) {
        patch(integration.id, { error: { code: "REVISION_FILE_CONFLICT", message: "같은 경로의 revision 파일이 있어 자동으로 합칠 수 없습니다." } });
        return;
      }
      store.setState({ busy: true, progress: "Alice와 Bob의 revision 파일을 integration에 합치는 중", activeId: integration.id });
      try {
        let snapshot = integration.snapshot;
        const changes: FileChange[] = [];
        for (const item of branchFiles) {
          const sourceClient = clients.get(item.actor.id);
          if (!sourceClient) throw new Error(`Missing runtime for ${item.actor.name}`);
          const content = await sourceClient.readFile(item.path);
          const written = await integrationClient.writeFile(item.path, content);
          snapshot = written.state;
          changes.push(...written.fileChanges);
        }
        patch(integration.id, { snapshot, changes, error: undefined, stale: false });
        store.setState({ collaboration: { ...collaboration, filesIntegrated: true,
          multipleHeadsObserved: (snapshot?.revisions.filter((revision) => revision.isHead).length ?? 0) > 1 }, panel: "graph" });
      } catch (error) {
        patch(integration.id, { error: runtimeFault(error) });
      } finally {
        store.setState({ busy: false, progress: "Integration graph 확인 완료" });
      }
    },
    dispose() { clients.forEach((client) => client.close()); clients.clear(); },
  };
}
export type Lab = ReturnType<typeof createLab>;
