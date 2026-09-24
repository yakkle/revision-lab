import { expect, test } from "@playwright/test";

test("loads Vite development mode with a nonce and keeps unsafe-eval scoped to PGlite", async ({ page, request }) => {
  test.setTimeout(180_000);
  const document = await request.get("/");
  const csp = document.headers()["content-security-policy"] ?? "";
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).not.toContain("'unsafe-inline'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).toContain("connect-src 'self' ws: wss:");
  const html = await document.text();
  expect(html).toContain(`nonce="${nonce}"`);
  expect(html).toContain("/@react-refresh");

  const worker = await request.get("/src/runtime/pglite.worker.ts?worker_file&type=module");
  expect(worker.headers()["content-security-policy"]).toContain("script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'");

  const cspErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to/i.test(message.text()))
      cspErrors.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Migration 실습실" })).toBeVisible();
  await page.getByRole("button", { name: "PostgreSQL workspace 만들기", exact: true }).click();
  const run = page.getByRole("button", { name: "명령 실행", exact: true });
  await expect(run).toBeEnabled({ timeout: 120_000 });
  await run.click();
  await expect(run).toBeEnabled({ timeout: 60_000 });
  await page
    .getByRole("navigation", { name: "Workspace 파일" })
    .getByRole("button", { name: "alembic.ini", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "코드 편집기 alembic.ini" })).toBeVisible();
  const editorLayout = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".code-editor")!;
    const editor = document.querySelector<HTMLElement>(".cm-editor")!;
    const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
    const firstLine = document.querySelector<HTMLElement>(".cm-line")!;
    const scrollerRect = scroller.getBoundingClientRect();
    const firstLineRect = firstLine.getBoundingClientRect();
    return {
      editorDisplay: getComputedStyle(editor).display,
      hostHeight: host.clientHeight,
      scrollerHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      firstLineInsideScroller: firstLineRect.top >= scrollerRect.top && firstLineRect.bottom <= scrollerRect.bottom,
    };
  });
  expect(editorLayout.editorDisplay).toBe("flex");
  expect(editorLayout.scrollerHeight).toBeLessThanOrEqual(editorLayout.hostHeight);
  expect(editorLayout.scrollHeight).toBeGreaterThan(editorLayout.scrollerHeight);
  expect(editorLayout.firstLineInsideScroller).toBe(true);
  expect(cspErrors).toEqual([]);
});
