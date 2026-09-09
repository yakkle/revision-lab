import { describe, expect, it, vi } from "vitest";
import { createLab, type LabClient } from "./store";
import { RuntimeClientError } from "../runtime/runtime-client";
import type { CommandResult, WorkspaceState } from "../runtime/protocol";

const snapshot: WorkspaceState = { files: ["models.py"], revisions: [], schema: { dialect: "sqlite", tables: [], alembicVersion: [] } };
const result: CommandResult = { success: true, argv: ["init"], before: snapshot, after: snapshot, stdout: "done", stderr: "", fileChanges: [], schemaDiff: { changes: [], alembicVersion: { before: [], after: [] } } };
function client(): LabClient {
  return { createWorkspace: vi.fn().mockResolvedValue(snapshot), readFile: vi.fn().mockResolvedValue("original"),
    writeFile: vi.fn().mockResolvedValue({ state: snapshot, fileChanges: [] }), runCommand: vi.fn().mockResolvedValue(result),
    readTable: vi.fn().mockResolvedValue({ table: "users", columns: [], rows: [], truncated: false }), close: vi.fn() };
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
});
