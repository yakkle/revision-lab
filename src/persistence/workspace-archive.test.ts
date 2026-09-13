import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { createWorkspaceArchive, readWorkspaceArchive, WorkspaceArchiveError, type WorkspaceArchiveV1 } from "./workspace-archive";

const archive: WorkspaceArchiveV1 = {
  formatVersion: 1,
  workspace: { id: "sqlite-test", name: "SQLite 학습", mode: "sqlite" },
  files: [
    { path: "alembic.ini", encoding: "utf8", content: "[alembic]\nscript_location = migrations\n" },
    { path: "migrations/versions/r1.py", encoding: "utf8", content: "revision = 'r1'\n" },
  ],
  database: { format: "sqlite-file", content: new Uint8Array([83, 81, 76]).buffer },
  lessonProgress: { initializedObserved: "true" },
};

describe("WorkspaceArchiveV1", () => {
  it("round-trips UTF-8 files, database bytes and lesson progress through a real ZIP", async () => {
    const blob = await createWorkspaceArchive(archive);
    expect(blob.type).toBe("application/zip");
    const restored = await readWorkspaceArchive(blob);
    expect(restored.workspace).toEqual(archive.workspace);
    expect(restored.files).toEqual(archive.files);
    expect(new Uint8Array(restored.database.content)).toEqual(new Uint8Array(archive.database.content));
    expect(restored.lessonProgress).toEqual(archive.lessonProgress);
  });

  it("rejects traversal entries before decompression or Python execution", async () => {
    const malicious = zipSync({ "../escape.py": strToU8("raise SystemExit") });
    await expect(readWorkspaceArchive(malicious.slice().buffer)).rejects.toMatchObject<Partial<WorkspaceArchiveError>>({ code: "ARCHIVE_INVALID_PATH" });
  });

  it("rejects a database payload that does not match the workspace mode", async () => {
    await expect(createWorkspaceArchive({ ...archive, database: { ...archive.database, format: "pglite-datadir" } }))
      .rejects.toMatchObject<Partial<WorkspaceArchiveError>>({ code: "ARCHIVE_INVALID_DATABASE" });
  });

  it("rejects a corrupt manifest that aliases two workspace files to one ZIP entry", async () => {
    const manifest = {
      formatVersion: 1,
      workspace: archive.workspace,
      files: [
        { path: "first.py", encoding: "utf8", entry: "files/shared.txt" },
        { path: "second.py", encoding: "utf8", entry: "files/shared.txt" },
      ],
      database: { format: "sqlite-file", entry: "database.sqlite" },
      lessonProgress: {},
    };
    const corrupt = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "files/shared.txt": strToU8("revision = 'shared'"),
      "database.sqlite": new Uint8Array([83, 81, 76]),
    });
    await expect(readWorkspaceArchive(corrupt.slice().buffer))
      .rejects.toMatchObject<Partial<WorkspaceArchiveError>>({ code: "ARCHIVE_INVALID_MANIFEST" });
  });
});
