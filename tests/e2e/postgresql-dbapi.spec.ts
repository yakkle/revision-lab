import { expect, test } from "@playwright/test";

test("runs SQLAlchemy through pglite_dbapi and reflects PostgreSQL constraints", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Boolean(window.__revisionLabT4))).toBe(true);

  const report = await page.evaluate(() => window.__revisionLabT4!.probe());

  expect(report.engine).toEqual({ dialect: "postgresql", driver: "pglite" });
  expect(report.selected).toEqual({ id: 2, parentId: 2, code: "beta", score: 20 });
  expect(report.executemanyRowCount).toBe(2);
  expect(report.rolledBackCount).toBe(0);
  expect(report.values).toEqual([
    { value: "9007199254740993", type: "int" },
    { value: "1234567890.12345", type: "Decimal" },
    { value: "2026-09-08", type: "date" },
    { value: "b'revision-lab'", type: "bytes" },
  ]);
  expect(report.inspection.primaryKey).toEqual(["id"]);
  expect(report.inspection.foreignKeys).toContainEqual({
    columns: ["parent_id"],
    referredTable: "t4_parents",
    referredColumns: ["id"],
  });
  expect(report.inspection.uniqueConstraints).toContainEqual(["code"]);
  expect(report.inspection.checkConstraints.some((sql) => sql.includes("score >= 0"))).toBe(true);
  expect(report.inspection.indexes).toContainEqual({ name: "ix_t4_children_parent_id", columns: ["parent_id"], unique: false });
  expect(report.integrityError).toMatchObject({ className: "IntegrityError", sqlState: "23505" });
  expect(report.unsupportedError).toEqual({ className: "NotSupportedError", code: "DBAPI_NOT_SUPPORTED" });
  expect(report.secondConnectionError).toEqual({ className: "InterfaceError", code: "DBAPI_SINGLE_CONNECTION" });
});
