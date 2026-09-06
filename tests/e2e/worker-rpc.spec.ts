import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Boolean(window.__revisionLabT2))).toBe(true);
});

test("executes DDL, parameterized data, errors and 100 serial calls through Python", async ({ page }) => {
  test.setTimeout(90_000);
  const report = await page.evaluate(() => window.__revisionLabT2!.probe());
  expect(report.ddl.ok, JSON.stringify(report.ddl)).toBe(true);
  expect(report.insert).toMatchObject({ ok: true });
  expect(report.select).toMatchObject({ ok: true, rowCount: 1 });
  expect(report.databaseError).toMatchObject({ ok: false, error: { code: "PGLITE_DATABASE_ERROR", sqlState: "23505" } });
  expect(report.serialCount).toBe(100);
  expect(report.animationFrames).toBeGreaterThan(0);
});

test("bounds oversized responses and remains usable", async ({ page }) => {
  test.setTimeout(90_000);
  const oversized = await page.evaluate(() => window.__revisionLabT2!.query("SELECT repeat('x', 9 * 1024 * 1024) AS large"));
  expect(oversized).toMatchObject({ ok: false, error: { code: "RPC_RESPONSE_TOO_LARGE" } });
  const healthy = await page.evaluate(() => window.__revisionLabT2!.query("SELECT $1::integer AS value", [7]));
  expect(healthy).toMatchObject({ ok: true, rowCount: 1 });
});

test("returns a 15 second timeout and restarts both Workers", async ({ page }) => {
  test.setTimeout(120_000);
  const timedOut = await page.evaluate(() => window.__revisionLabT2!.query("SELECT pg_sleep(16)"));
  expect(timedOut).toMatchObject({ ok: false, error: { code: "RPC_TIMEOUT" } });
  const afterRestart = await page.evaluate(() => window.__revisionLabT2!.query("SELECT 1 AS ready"));
  expect(afterRestart).toMatchObject({ ok: true, rowCount: 1 });
});
