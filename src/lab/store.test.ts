import { describe, expect, it, vi } from "vitest";
import { createLab, type LabClient } from "./store";
import { RuntimeClientError } from "../runtime/runtime-client";
import type { CommandResult, RuntimeCloneSeed, WorkspaceState } from "../runtime/protocol";
import type { CheckpointRepository, PersistedSession, WorkspaceCheckpoint } from "../persistence/checkpoints";

const snapshot: WorkspaceState = { files: ["models.py"], revisions: [], schema: { dialect: "sqlite", tables: [], alembicVersion: [] } };
const result: CommandResult = { success: true, argv: ["init"], before: snapshot, after: snapshot, stdout: "done", stderr: "", fileChanges: [], schemaDiff: { changes: [], alembicVersion: { before: [], after: [] } } };
function client(): LabClient {
  return { createWorkspace: vi.fn().mockResolvedValue(snapshot), readFile: vi.fn().mockResolvedValue("original"),
    exportClone: vi.fn().mockResolvedValue({ files: [{ path: "models.py", content: "original" }], sqliteDatabase: "" }),
    writeFile: vi.fn().mockResolvedValue({ state: snapshot, fileChanges: [] }), runCommand: vi.fn().mockResolvedValue(result),
    readTable: vi.fn().mockResolvedValue({ table: "users", columns: [], rows: [], truncated: false }), close: vi.fn() };
}

function repository(restored?: { session: PersistedSession; checkpoints: WorkspaceCheckpoint[] }): CheckpointRepository {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    saveSession: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(restored),
    loadCheckpoint: vi.fn().mockImplementation(async (id: string) => restored?.checkpoints.find((item) => item.workspace.id === id)),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Lab workspace orchestration", () => {
  it("resets only the selected workspace and releases its runtime", async () => {
    const first = client();
    const second = client();
    const replacement = client();
    const lab = createLab(vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(replacement));
    await lab.create("sqlite");
    const firstId = lab.store.getState().activeId;
    await lab.create("sqlite");
    await lab.reset();
    expect(second.close).toHaveBeenCalledOnce();
    expect(first.close).not.toHaveBeenCalled();
    expect(lab.store.getState().workspaces).toHaveLength(2);
    expect(lab.store.getState().workspaces[0].id).toBe(firstId);
    expect(new Set(lab.store.getState().workspaces.map((item) => item.name)).size).toBe(2);
    expect(replacement.createWorkspace).toHaveBeenCalledOnce();
    lab.dispose();
  });
  it("blocks duplicate operations and workspace switching until an operation completes", async () => {
    const runtime = client();
    const lab = createLab(() => runtime);
    await lab.create("sqlite");
    const firstId = lab.store.getState().activeId;
    await lab.create("sqlite");
    const secondId = lab.store.getState().activeId;
    let finish!: (result: CommandResult) => void;
    vi.mocked(runtime.runCommand).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const running = lab.run("alembic heads");
    await lab.run("alembic heads");
    await lab.create("sqlite");
    lab.select(firstId!);
    expect(lab.store.getState().activeId).toBe(secondId);
    expect(runtime.runCommand).toHaveBeenCalledTimes(1);
    finish(result);
    await running;
    expect(lab.store.getState().busy).toBe(false);
    lab.dispose();
  });

  it("preserves drafts when switching workspaces and saves only the selected workspace", async () => {
    const first = client();
    const second = client();
    const lab = createLab(vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second));
    await lab.create("sqlite");
    const firstId = lab.store.getState().activeId!;
    await lab.openFile("models.py");
    lab.edit("unsaved");
    await lab.create("postgresql");
    await lab.openFile("models.py");
    expect(lab.store.getState().workspaces[1].drafts["models.py"].text).toBe("original");
    lab.select(firstId);
    expect(lab.store.getState().workspaces[0].drafts["models.py"].text).toBe("unsaved");
    await lab.save();
    expect(first.writeFile).toHaveBeenCalledWith("models.py", "unsaved");
    expect(second.writeFile).not.toHaveBeenCalled();
    lab.dispose();
  });

  it("uses the actual failed-command snapshot and preserves the original error", async () => {
    const runtime = client();
    const failed = { ...result, success: false, after: { ...snapshot, schema: { ...snapshot.schema, alembicVersion: ["actual"] } }, error: { code: "ALEMBIC_COMMAND_FAILED", message: "original SQL error" }, traceback: "original traceback" };
    vi.mocked(runtime.runCommand).mockResolvedValue(failed);
    const lab = createLab(() => runtime);
    await lab.create("sqlite");
    await lab.run("alembic upgrade head");
    const workspace = lab.store.getState().workspaces[0];
    expect(workspace.snapshot).toEqual(failed.after);
    expect(workspace.error).toEqual(failed.error);
    expect(workspace.entries[0].result?.traceback).toBe("original traceback");
    expect(workspace.broken).toBe(false);
    lab.dispose();
  });

  it("checkpoints successful commands but never replaces the checkpoint with a failed migration", async () => {
    const runtime = client();
    const persistence = repository();
    const lab = createLab(() => runtime, persistence);
    await lab.create("sqlite");
    expect(persistence.save).toHaveBeenCalledTimes(1);

    await lab.run("alembic heads");
    expect(persistence.save).toHaveBeenCalledTimes(2);
    vi.mocked(runtime.runCommand).mockResolvedValueOnce({ ...result, success: false,
      error: { code: "ALEMBIC_COMMAND_FAILED", message: "migration failed" } });
    await lab.run("alembic upgrade head");
    expect(persistence.save).toHaveBeenCalledTimes(2);
    lab.dispose();
  });

  it("restores runtime files, database seed, lesson evidence, and the selected workspace from IndexedDB metadata", async () => {
    const seed: RuntimeCloneSeed = { files: [{ path: "models.py", content: "restored" }], sqliteDatabase: "AA==" };
    const checkpoint: WorkspaceCheckpoint = {
      formatVersion: 1,
      workspace: { id: "sqlite-saved", name: "저장된 SQLite", mode: "sqlite", evidence: {
        initializedObserved: true, manualRevisionCreated: false, manualUnappliedObserved: false, upgradeObserved: false,
        downgradeObserved: false, autogeneratedRevisions: [], reviewedRevisions: [], autogenerateApplied: false,
        multipleHeadsErrorObserved: false,
      }, file: "models.py", revision: "saved", entries: [] },
      seed,
      savedAt: 1234,
    };
    const session: PersistedSession = { formatVersion: 1, workspaceIds: [checkpoint.workspace.id], activeId: checkpoint.workspace.id,
      panel: "database", guideEnabled: true, activeLesson: "autogenerate" };
    const persistence = repository({ session, checkpoints: [checkpoint] });
    const runtime = client();
    vi.mocked(runtime.readFile).mockResolvedValue("restored");
    const factory = vi.fn(() => runtime);
    const lab = createLab(factory, persistence);

    await lab.restore();

    expect(factory).toHaveBeenCalledWith("sqlite", "sqlite-saved", seed);
    expect(lab.store.getState()).toMatchObject({ activeId: "sqlite-saved", panel: "database", guideEnabled: true, activeLesson: "autogenerate" });
    expect(lab.store.getState().workspaces[0]).toMatchObject({ savedAt: 1234, revision: "saved", drafts: { "models.py": { text: "restored", saved: "restored" } } });
    lab.dispose();
  });

  it("retains the last snapshot after a timeout and creates a new runtime only on explicit create", async () => {
    const runtime = client();
    vi.mocked(runtime.runCommand).mockRejectedValue(new RuntimeClientError({ code: "ALEMBIC_COMMAND_TIMEOUT", message: "timeout" }));
    const factory = vi.fn(() => runtime);
    const lab = createLab(factory);
    await lab.create("sqlite");
    await lab.run("alembic upgrade head");
    await lab.run("alembic heads");
    expect(runtime.runCommand).toHaveBeenCalledTimes(1);
    expect(lab.store.getState().workspaces[0]).toMatchObject({ broken: true, stale: true, snapshot });
    expect(factory).toHaveBeenCalledTimes(1);
    await lab.create("sqlite");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(lab.store.getState().workspaces).toHaveLength(2);
    lab.dispose();
  });

  it("clones a real common base and integrates only Alice and Bob revision files", async () => {
    const baseRevision = { revision: "base", path: "migrations/versions/base.py", downRevisions: [], branchLabels: [], dependsOn: [],
      isHead: true, isBranchPoint: false, isMergePoint: false, isCurrent: true };
    const baseState: WorkspaceState = { files: ["alembic.ini", "models.py", "migrations/env.py", baseRevision.path], revisions: [baseRevision],
      schema: { dialect: "sqlite", tables: [], alembicVersion: ["base"] } };
    const seed = { files: [{ path: "models.py", content: "base" }], sqliteDatabase: "AA==" };
    const source = client();
    vi.mocked(source.createWorkspace).mockResolvedValue(baseState);
    vi.mocked(source.exportClone).mockResolvedValue(seed);
    const aliceClient = client();
    const bobClient = client();
    const integrationClient = client();
    for (const runtime of [aliceClient, bobClient, integrationClient]) vi.mocked(runtime.createWorkspace).mockResolvedValue(baseState);
    vi.mocked(aliceClient.readFile).mockResolvedValue("revision = 'alice'");
    vi.mocked(bobClient.readFile).mockResolvedValue("revision = 'bob'");
    const aliceRevision = { ...baseRevision, revision: "alice", path: "migrations/versions/alice.py", downRevisions: ["base"], isCurrent: false };
    const bobRevision = { ...baseRevision, revision: "bob", path: "migrations/versions/bob.py", downRevisions: ["base"], isCurrent: false };
    const branchedState = (revisionNode: typeof aliceRevision): WorkspaceState => ({ ...baseState, files: [...baseState.files, revisionNode.path],
      revisions: [revisionNode, { ...baseRevision, isHead: false }] });
    const integrationStates = [branchedState(aliceRevision), { ...baseState,
      files: [...baseState.files, aliceRevision.path, bobRevision.path],
      revisions: [aliceRevision, bobRevision, { ...baseRevision, isHead: false, isBranchPoint: true }],
    }];
    vi.mocked(integrationClient.writeFile)
      .mockResolvedValueOnce({ state: integrationStates[0], fileChanges: [{ path: aliceRevision.path, change: "added" }] })
      .mockResolvedValueOnce({ state: integrationStates[1], fileChanges: [{ path: bobRevision.path, change: "added" }] });
    const factory = vi.fn().mockReturnValueOnce(source).mockReturnValueOnce(aliceClient).mockReturnValueOnce(bobClient).mockReturnValueOnce(integrationClient);
    const lab = createLab(factory);
    await lab.create("sqlite");
    await lab.setupCollaboration();
    const collaboration = lab.store.getState().collaboration!;
    expect(factory.mock.calls.slice(1).every((call) => call[2] === seed)).toBe(true);
    expect(lab.store.getState().workspaces.map((workspace) => workspace.role)).toEqual(["base", "alice", "bob", "integration"]);
    lab.store.setState((state) => ({ workspaces: state.workspaces.map((workspace) =>
      workspace.id === collaboration.aliceId ? { ...workspace, snapshot: branchedState(aliceRevision) }
        : workspace.id === collaboration.bobId ? { ...workspace, snapshot: branchedState(bobRevision) } : workspace) }));
    await lab.integrateBranches();
    expect(aliceClient.readFile).toHaveBeenCalledWith(aliceRevision.path);
    expect(bobClient.readFile).toHaveBeenCalledWith(bobRevision.path);
    expect(integrationClient.writeFile).toHaveBeenNthCalledWith(1, aliceRevision.path, "revision = 'alice'");
    expect(integrationClient.writeFile).toHaveBeenNthCalledWith(2, bobRevision.path, "revision = 'bob'");
    expect(lab.store.getState().collaboration?.filesIntegrated).toBe(true);
    expect(lab.store.getState().activeId).toBe(collaboration.integrationId);
    lab.dispose();
  });
});
