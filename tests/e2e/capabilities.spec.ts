import { expect, test } from "@playwright/test";

test("keeps module responses out of the WebKit cache without disabling WASM caching", async ({ request }) => {
  const script = await request.head("/runtime/pyodide/pyodide.mjs");
  expect(script.status()).toBe(200);
  expect(script.headers()["cache-control"]).toBe("no-store");
  expect(script.headers()["cross-origin-resource-policy"]).toBe("same-origin");
  const revalidated = await request.head("/runtime/pyodide/pyodide.mjs", { headers: { "If-None-Match": script.headers().etag! } });
  expect(revalidated.status()).toBe(304);
  expect(revalidated.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
  const wasm = await request.head("/runtime/pyodide/pyodide.asm.wasm");
  expect(wasm.status()).toBe(200);
  expect(wasm.headers()["cache-control"] ?? "").not.toContain("no-store");
});

test("enables the PostgreSQL environment on an isolated preview", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Migration 실습실" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PostgreSQL 환경 선택" })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
});

test("keeps SQLite available and disables PostgreSQL without isolation headers", async ({ page }) => {
  await page.goto("http://127.0.0.1:4174/");

  await expect(page.getByRole("button", { name: "SQLite 환경 선택" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "PostgreSQL 환경 선택" })).toBeDisabled();
  await expect(page.getByText(/COOP\/COEP 헤더를 제공하는 환경/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => globalThis.crossOriginIsolated)).toBe(false);
});
