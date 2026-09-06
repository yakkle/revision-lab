import { expect, test } from "@playwright/test";

test("enables the PostgreSQL environment on an isolated preview", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "이 브라우저의 실습 환경" })).toBeVisible();
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
