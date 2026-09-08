import { expect, test } from "@playwright/test";

const revision = (id: string, downRevision: string | null, upgradeBody: string, downgradeBody = "pass") => `from alembic import op
import sqlalchemy as sa

revision = "${id}"
down_revision = ${downRevision === null ? "None" : `"${downRevision}"`}
branch_labels = None
depends_on = None

def upgrade():
    ${upgradeBody.replaceAll("\n", "\n    ")}

def downgrade():
    ${downgradeBody.replaceAll("\n", "\n    ")}
`;

for (const mode of ["sqlite", "postgresql"] as const) {
test(`runs the complete ${mode} Alembic command and inspection flow`, async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  // Run precisely the same lesson commands against either real runtime.
  if (mode === "postgresql") {
    await page.evaluate(() => { window.__revisionLabT3 = window.__revisionLabT5; });
  }
  await expect.poll(() => page.evaluate(() => Boolean(window.__revisionLabT3))).toBe(true);

  const initial = await page.evaluate(() => window.__revisionLabT3!.createWorkspace());
  expect(initial).toMatchObject({ files: [], revisions: [], schema: { dialect: mode, tables: [], alembicVersion: [] } });

  const initialized = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["init"]));
  expect(initialized.success, initialized.traceback).toBe(true);
  expect(initialized.fileChanges.map((change) => change.path)).toEqual(expect.arrayContaining([
    "alembic.ini", "alembic/env.py", "alembic/script.py.mako", "models.py",
  ]));
  expect(await page.evaluate(() => window.__revisionLabT3!.readFile("alembic.ini"))).toContain(
    mode === "postgresql" ? "postgresql+pglite://" : "sqlite:///",
  );
  const traversal = await page.evaluate(async () => {
    try {
      await window.__revisionLabT3!.readFile("../outside.py");
      return null;
    } catch (error) {
      return (error as { fault?: { code?: string } }).fault ?? null;
    }
  });
  expect(traversal).toMatchObject({ code: "RUNTIME_INVALID_REQUEST" });

  const manual = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["revision", "-m", "create users", "--rev-id", "001"]));
  expect(manual.success, manual.traceback).toBe(true);
  const manualPath = manual.fileChanges.find((change) => change.path.includes("/versions/"))?.path;
  expect(manualPath).toBeTruthy();
  await page.evaluate(
    ({ path, content }) => window.__revisionLabT3!.writeFile(path, content),
    {
      path: manualPath!,
      content: revision(
        "001",
        null,
        'op.create_table("users", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("name", sa.String(80), nullable=False))',
        'op.drop_table("users")',
      ),
    },
  );

  const upgraded = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["upgrade", "head"]));
  expect(upgraded.success, upgraded.traceback).toBe(true);
  expect(upgraded.after.schema.alembicVersion).toEqual(["001"]);
  expect(upgraded.schemaDiff).toMatchObject({
    changes: expect.arrayContaining([expect.objectContaining({ kind: "table", table: "users", change: "added" })]),
    alembicVersion: { before: [], after: ["001"] },
  });
  expect(upgraded.after.schema.tables.find((table) => table.name === "users")?.columns.map((column) => column.name)).toEqual(["id", "name"]);

  for (const argv of [["current", "--verbose"], ["history", "--verbose"], ["heads"], ["branches"], ["show", "001"]]) {
    const result = await page.evaluate((command) => window.__revisionLabT3!.runAlembic(command), argv);
    expect(result.success, `${argv.join(" ")}\n${result.traceback ?? ""}`).toBe(true);
    if (argv[0] !== "branches") expect(result.stdout).toContain("001");
  }

  const downgraded = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["downgrade", "base"]));
  expect(downgraded.success, downgraded.traceback).toBe(true);
  expect(downgraded.after.schema.alembicVersion).toEqual([]);
  expect(downgraded.after.schema.tables).toEqual([]);
  expect((await page.evaluate(() => window.__revisionLabT3!.runAlembic(["upgrade", "head"]))).success).toBe(true);

  await page.evaluate(() => window.__revisionLabT3!.writeFile("models.py", `from sqlalchemy import Column, Integer, MetaData, String, Table

metadata = MetaData()
Table("users", metadata,
    Column("id", Integer, primary_key=True),
    Column("name", String(80), nullable=False),
    Column("email", String(200), nullable=True),
)
`));
  const generated = await page.evaluate(() => window.__revisionLabT3!.runAlembic([
    "revision", "--autogenerate", "-m", "add email", "--rev-id", "002",
  ]));
  expect(generated.success, generated.traceback).toBe(true);
  const generatedPath = generated.fileChanges.find((change) => change.path.includes("/versions/"))?.path;
  expect(await page.evaluate((path) => window.__revisionLabT3!.readFile(path!), generatedPath)).toContain("add_column");
  const generatedUpgrade = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["upgrade", "head"]));
  expect(generatedUpgrade.success, generatedUpgrade.traceback).toBe(true);
  expect(generatedUpgrade.schemaDiff.changes).toContainEqual(expect.objectContaining({ kind: "column", table: "users", name: "email", change: "added" }));
  expect(generatedUpgrade.after.schema.tables[0]?.columns.map((column) => column.name)).toEqual(["id", "name", "email"]);
  expect((await page.evaluate(() => window.__revisionLabT3!.runAlembic(["downgrade", "001"]))).after.schema.alembicVersion).toEqual(["001"]);
  expect((await page.evaluate(() => window.__revisionLabT3!.runAlembic(["upgrade", "head"]))).after.schema.alembicVersion).toEqual(["002"]);

  expect((await page.evaluate(() => window.__revisionLabT3!.runAlembic(["revision", "-m", "alice", "--head", "002", "--rev-id", "a1"]))).success).toBe(true);
  expect((await page.evaluate(() => window.__revisionLabT3!.runAlembic(["revision", "-m", "bob", "--head", "002", "--splice", "--rev-id", "b1"]))).success).toBe(true);
  for (const [id, column] of [["a1", "alice_note"], ["b1", "bob_note"]]) {
    const content = revision(id!, "002", `op.add_column("users", sa.Column("${column}", sa.String(40)))`, `op.drop_column("users", "${column}")`);
    await page.evaluate(async ({ id, content }) => {
      const state = await window.__revisionLabT3!.inspect();
      const path = state.files.find((file) => file.includes(`/versions/${id}_`))!;
      await window.__revisionLabT3!.writeFile(path, content);
    }, { id, content });
  }
  const multipleHeads = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["upgrade", "head"]));
  expect(multipleHeads.success).toBe(false);
  expect(multipleHeads.error?.message).toContain("Multiple head revisions");
  expect(multipleHeads.traceback).toContain("MultipleHeads");
  expect(multipleHeads.after.schema.alembicVersion).toEqual(["002"]);
  expect(multipleHeads.after.revisions.filter((node) => node.isHead).map((node) => node.revision).sort()).toEqual(["a1", "b1"]);

  const branches = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["branches", "--verbose"]));
  expect(branches.success, branches.traceback).toBe(true);
  expect(branches.stdout).toContain("002");
  const upgradedHeads = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["upgrade", "heads"]));
  expect(upgradedHeads.success, upgradedHeads.traceback).toBe(true);
  expect(upgradedHeads.after.schema.alembicVersion).toEqual(["a1", "b1"]);
  expect(upgradedHeads.after.schema.tables[0]!.columns.map((column) => column.name).sort()).toEqual(["alice_note", "bob_note", "email", "id", "name"]);
  expect(upgradedHeads.after.revisions.filter((node) => node.isCurrent).map((node) => node.revision).sort()).toEqual(["a1", "b1"]);
  const merged = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["merge", "a1", "b1", "-m", "merge branches", "--rev-id", "m1"]));
  expect(merged.success, merged.traceback).toBe(true);
  expect(merged.after.revisions.find((node) => node.revision === "m1")).toMatchObject({ downRevisions: ["a1", "b1"], isHead: true, isMergePoint: true });
  const mergedUpgrade = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["upgrade", "head"]));
  expect(mergedUpgrade.success, mergedUpgrade.traceback).toBe(true);
  expect(mergedUpgrade.after.schema.alembicVersion).toEqual(["m1"]);

  const failedRevision = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["revision", "-m", "broken SQL", "--rev-id", "fail1"]));
  const failedPath = failedRevision.fileChanges.find((change) => change.path.includes("/versions/"))?.path;
  await page.evaluate(
    ({ path, content }) => window.__revisionLabT3!.writeFile(path, content),
    { path: failedPath!, content: revision("fail1", "m1", 'op.create_table("rollback_probe", sa.Column("id", sa.Integer(), primary_key=True))\nop.execute("THIS IS NOT SQL")') },
  );
  const failedUpgrade = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["upgrade", "head"]));
  expect(failedUpgrade.success).toBe(false);
  expect(failedUpgrade.error).toMatchObject({ code: "ALEMBIC_COMMAND_FAILED" });
  expect(failedUpgrade.traceback).toContain(mode === "postgresql" ? "ProgrammingError" : "OperationalError");
  expect(failedUpgrade.after.schema.alembicVersion).toEqual(["m1"]);
  expect(await page.evaluate(() => window.__revisionLabT3!.inspect())).toEqual(failedUpgrade.after);
  if (mode === "postgresql") {
    expect(failedUpgrade.error?.sqlState).toBe("42601");
    expect(failedUpgrade.after.schema).toEqual(failedUpgrade.before.schema);
    expect(failedUpgrade.schemaDiff.changes).toEqual([]);
  } else {
    // sqlite3 legacy transaction control can retain DDL issued before BEGIN.
    expect(failedUpgrade.after.schema.tables.some((table) => table.name === "rollback_probe")).toBe(true);
  }

  const rejected = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["stamp", "head"]));
  expect(rejected).toMatchObject({ success: false, error: { code: "UNSUPPORTED_ALEMBIC_COMMAND" } });
  const rejectedOption = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["upgrade", "--sql", "head"]));
  expect(rejectedOption).toMatchObject({ success: false, error: { code: "UNSUPPORTED_ALEMBIC_OPTION" } });
  const concurrent = await page.evaluate(async () => {
    const requests = await Promise.allSettled([window.__revisionLabT3!.inspect(), window.__revisionLabT3!.inspect()]);
    return requests.map((result) => result.status === "fulfilled" ? "OK" : (result.reason as { fault: { code: string } }).fault.code);
  });
  expect(concurrent).toEqual(["OK", "RUNTIME_BUSY"]);
  await page.evaluate(() => window.__revisionLabT3!.close());
});
}

test("runs SQLite without cross-origin isolation", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("http://127.0.0.1:4174/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await expect.poll(() => page.evaluate(() => Boolean(window.__revisionLabT3))).toBe(true);
  await page.evaluate(() => window.__revisionLabT3!.createWorkspace());
  const initialized = await page.evaluate(() => window.__revisionLabT3!.runAlembic(["init"]));
  expect(initialized.success, initialized.traceback).toBe(true);
  expect(initialized.after.schema).toMatchObject({ dialect: "sqlite", tables: [], alembicVersion: [] });
});
