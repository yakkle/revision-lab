import { expect, test } from "@playwright/test";

const models = (length: number, nullable: boolean) => `from sqlalchemy import (
    MetaData, Table, Column, Integer, String, Numeric, Boolean, DateTime,
    ForeignKey, UniqueConstraint, CheckConstraint, Index, Identity,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY

metadata = MetaData()
Table("teams", metadata, Column("id", Integer, Identity(), primary_key=True))
Table("members", metadata,
    Column("id", Integer, primary_key=True),
    Column("team_id", Integer, ForeignKey("teams.id", name="fk_members_team")),
    Column("label", String(${length}), nullable=${nullable ? "True" : "False"}),
    Column("balance", Numeric(12, 2)),
    Column("enabled", Boolean, server_default="true"),
    Column("created_at", DateTime(timezone=True)),
    Column("public_id", UUID),
    Column("payload", JSONB),
    Column("scores", ARRAY(Integer)),
    UniqueConstraint("label", name="uq_members_label"),
    CheckConstraint("balance >= 0", name="ck_members_balance"),
    Index("ix_members_team", "team_id"),
)
`;

test("reflects PostgreSQL types, identity and constraints and autogenerates ALTER TABLE", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.evaluate(() => window.__revisionLabT5!.createWorkspace());
  const init = await page.evaluate(() => window.__revisionLabT5!.runAlembic(["init"]));
  expect(init.success, init.traceback).toBe(true);
  await page.evaluate((content) => window.__revisionLabT5!.writeFile("models.py", content), models(20, true));
  const generated = await page.evaluate(() => window.__revisionLabT5!.runAlembic(["revision", "--autogenerate", "--rev-id", "pg1", "-m", "create members"]));
  expect(generated.success, generated.traceback).toBe(true);
  expect(generated.after.schema.tables).toEqual([]);
  const up = await page.evaluate(() => window.__revisionLabT5!.runAlembic(["upgrade", "head"]));
  expect(up.success, up.traceback).toBe(true);
  const members = up.after.schema.tables.find((table) => table.name === "members")!;
  expect(up.after.schema.dialect).toBe("postgresql");
  expect(up.after.schema.alembicVersion).toEqual(["pg1"]);
  expect(members.columns).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "balance", type: "NUMERIC(12, 2)" }),
    expect.objectContaining({ name: "enabled", type: "BOOLEAN", default: "true" }),
    expect.objectContaining({ name: "created_at", type: "TIMESTAMP WITH TIME ZONE" }),
    expect.objectContaining({ name: "public_id", type: "UUID" }),
    expect.objectContaining({ name: "payload", type: "JSONB" }),
    expect.objectContaining({ name: "scores", type: "INTEGER[]" }),
  ]));
  expect(members.primaryKey.columns).toEqual(["id"]);
  expect(members.foreignKeys).toContainEqual(expect.objectContaining({ name: "fk_members_team", columns: ["team_id"], referredTable: "teams", referredColumns: ["id"] }));
  expect(members.uniqueConstraints).toContainEqual({ name: "uq_members_label", columns: ["label"] });
  expect(members.checkConstraints).toContainEqual(expect.objectContaining({ name: "ck_members_balance", sqlText: expect.stringContaining("balance >=") }));
  expect(members.indexes).toContainEqual({ name: "ix_members_team", columns: ["team_id"], unique: false });

  // Reflection of Identity uses json_build_object and must not produce a
  // spurious identity migration when metadata is unchanged.
  const noop = await page.evaluate(() => window.__revisionLabT5!.runAlembic(["revision", "--autogenerate", "--rev-id", "pg2"]));
  expect(noop.success, noop.traceback).toBe(true);
  const noopPath = noop.fileChanges.find((file) => file.path.includes("/versions/"))!.path;
  const noopSource = await page.evaluate((path) => window.__revisionLabT5!.readFile(path), noopPath);
  expect(noopSource).not.toContain("op.");
  expect((await page.evaluate(() => window.__revisionLabT5!.runAlembic(["upgrade", "head"]))).success).toBe(true);

  await page.evaluate((content) => window.__revisionLabT5!.writeFile("models.py", content), models(60, false));
  const altered = await page.evaluate(() => window.__revisionLabT5!.runAlembic(["revision", "--autogenerate", "--rev-id", "pg3"]));
  expect(altered.success, altered.traceback).toBe(true);
  const path = altered.fileChanges.find((file) => file.path.includes("/versions/"))!.path;
  const source = await page.evaluate((file) => window.__revisionLabT5!.readFile(file), path);
  expect(source).toContain("op.alter_column");
  expect(source).not.toContain("batch_alter_table");
  const changed = await page.evaluate(() => window.__revisionLabT5!.runAlembic(["upgrade", "head"]));
  expect(changed.success, changed.traceback).toBe(true);
  expect(changed.schemaDiff.changes).toContainEqual(expect.objectContaining({
    kind: "column", table: "members", name: "label", change: "modified",
    before: expect.objectContaining({ type: "VARCHAR(20)", nullable: true }),
    after: expect.objectContaining({ type: "VARCHAR(60)", nullable: false }),
  }));
  const down = await page.evaluate(() => window.__revisionLabT5!.runAlembic(["downgrade", "pg2"]));
  expect(down.success, down.traceback).toBe(true);
  expect(down.after.schema.tables).toEqual(up.after.schema.tables);
  const base = await page.evaluate(() => window.__revisionLabT5!.runAlembic(["downgrade", "base"]));
  expect(base.success, base.traceback).toBe(true);
  expect(base.after.schema).toEqual({ dialect: "postgresql", tables: [], alembicVersion: [] });
  await page.evaluate(() => window.__revisionLabT5!.close());
});

test("rejects PostgreSQL startup without cross-origin isolation", async ({ page }) => {
  await page.goto("http://127.0.0.1:4174/");
  const error = await page.evaluate(async () => {
    try {
      await window.__revisionLabT5!.createWorkspace();
      return null;
    } catch (failure) {
      return (failure as { fault: { code: string } }).fault;
    }
  });
  expect(error).toMatchObject({ code: "POSTGRESQL_UNAVAILABLE" });
});

test("rolls back failed downgrade DDL and data, then accepts a repaired migration", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.evaluate(() => window.__revisionLabT5!.createWorkspace());
  expect((await page.evaluate(() => window.__revisionLabT5!.runAlembic(["init"]))).success).toBe(true);
  const migration = `from alembic import op
import sqlalchemy as sa
revision = "data1"
down_revision = None
branch_labels = None
depends_on = None

def upgrade():
    op.create_table("items", sa.Column("id", sa.Integer(), primary_key=True))
    op.execute("INSERT INTO items VALUES (1)")

def downgrade():
    op.execute("INSERT INTO items VALUES (2)")
    op.add_column("items", sa.Column("temporary", sa.Integer()))
    op.execute("INSERT INTO items VALUES (1, NULL)")
`;
  await page.evaluate((content) => window.__revisionLabT5!.writeFile("alembic/versions/data1.py", content), migration);
  const upgraded = await page.evaluate(() => window.__revisionLabT5!.runAlembic(["upgrade", "head"]));
  expect(upgraded.success, upgraded.traceback).toBe(true);
  const failed = await page.evaluate(() => window.__revisionLabT5!.runAlembic(["downgrade", "base"]));
  expect(failed.success).toBe(false);
  expect(failed.error).toMatchObject({ code: "ALEMBIC_COMMAND_FAILED", sqlState: "23505" });
  expect(failed.traceback).toContain("IntegrityError");
  expect(failed.after.schema).toEqual(upgraded.after.schema);
  expect(failed.schemaDiff.changes).toEqual([]);
  expect(await page.evaluate(() => window.__revisionLabT5!.inspect())).toEqual(failed.after);

  const repaired = migration.slice(0, migration.indexOf("def downgrade():")) + `def downgrade():
    assert op.get_bind().scalar(sa.text("SELECT count(*) FROM items")) == 1
    op.drop_table("items")
`;
  await page.evaluate((content) => window.__revisionLabT5!.writeFile("alembic/versions/data1.py", content), repaired);
  const recovered = await page.evaluate(() => window.__revisionLabT5!.runAlembic(["downgrade", "base"]));
  expect(recovered.success, recovered.traceback).toBe(true);
  expect(recovered.after.schema).toEqual({ dialect: "postgresql", tables: [], alembicVersion: [] });
  await page.evaluate(() => window.__revisionLabT5!.close());
});
