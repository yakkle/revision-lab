import { expect, test, type Page } from "@playwright/test";

async function createWorkspace(page: Page, mode: "SQLite" | "PostgreSQL") {
  const diagnostics: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") diagnostics.push(`console:${message.type()}: ${message.text()}`); });
  page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => diagnostics.push(`requestfailed: ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));
  await page.goto("/");
  await page.getByRole("button", { name: `${mode} 환경 선택`, exact: true }).click();
  await page.getByRole("button", { name: "새 workspace 만들기", exact: true }).click();
  const run = page.getByRole("button", { name: "명령 실행", exact: true });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "명령 실행") as HTMLButtonElement | undefined;
    return button?.disabled === false || Boolean(document.querySelector(".error-box"));
  }, undefined, { timeout: 120_000 });
  if (await run.isDisabled()) throw new Error(`${await page.getByRole("alert").innerText()}\n\n${diagnostics.join("\n")}`);
  return diagnostics;
}

async function run(page: Page, command: string) {
  const input = page.getByRole("textbox", { name: "Alembic 명령" });
  const button = page.getByRole("button", { name: "명령 실행", exact: true });
  await input.fill(command);
  await button.click();
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator(".terminal-output > div").last()).toContainText("성공");
}

for (const mode of ["SQLite", "PostgreSQL"] as const) {
  test(`${mode}: reload, forced Worker recovery, and WorkspaceArchiveV1 preserve the real graph and DB`, async ({ page }) => {
    test.setTimeout(300_000);
    const diagnostics = await createWorkspace(page, mode);
    await run(page, "alembic init migrations");
    await run(page, 'alembic revision -m "checkpoint" --rev-id persisted1');
    await run(page, "alembic upgrade head");
    await page.getByRole("tab", { name: "Schema / Data", exact: true }).click();
    await expect(page.getByTestId("db-version")).toHaveText("persisted1");
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("준비됨") || Boolean(document.querySelector(".error-box")), undefined, { timeout: 120_000 });
    if (await page.getByRole("status").first().textContent() === "실행기 중단") throw new Error(`${await page.getByRole("alert").innerText()}\n${diagnostics.join("\n")}`);
    await page.getByRole("tab", { name: "Schema / Data", exact: true }).click();
    await expect(page.getByTestId("db-version")).toHaveText("persisted1");
    await page.getByRole("tab", { name: "Revision DAG", exact: true }).click();
    await expect(page.getByRole("list", { name: "Revision 목록" })).toContainText("persisted1");

    await page.evaluate(() => window.__revisionLabT8?.crashActive());
    await expect(page.getByText(/마지막 성공 체크포인트로 자동 복원했습니다/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("db-version")).toHaveText("persisted1");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Workspace 내보내기", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.revision-lab\.zip$/);
    const archivePath = await download.path();
    expect(archivePath).toBeTruthy();

    await page.getByLabel("Workspace archive 파일").setInputFiles(archivePath!);
    const dialog = page.getByRole("dialog", { name: "외부 workspace 확인" });
    await expect(dialog).toContainText(mode);
    await expect(dialog).toContainText("파일");
    await dialog.getByRole("button", { name: /persisted1_checkpoint\.py/ }).click();
    await expect(dialog.getByLabel("가져올 파일 내용")).toContainText("Revision ID: persisted1");
    await dialog.getByRole("checkbox", { name: "Python 파일 목록과 내용을 확인했습니다." }).check();
    await dialog.getByRole("button", { name: "확인 후 가져오기" }).click();
    await expect(page.getByRole("status").first()).toContainText("준비됨", { timeout: 120_000 });
    await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(/.+/);
    await page.getByRole("tab", { name: "Schema / Data", exact: true }).click();
    await expect(page.getByTestId("db-version")).toHaveText("persisted1");
    await page.getByRole("tab", { name: "Revision DAG", exact: true }).click();
    await expect(page.getByRole("list", { name: "Revision 목록" })).toContainText("persisted1");
  });
}

test("rejects a traversal ZIP before showing an execution confirmation", async ({ page }) => {
  await page.goto("/");
  const bytes = Buffer.from("UEsDBAoAAAAAAACAIQAAAAAAAAAAAAAAAAAMABwALi4vZXNjYXBlLnB5VVQJAAPzKdtm8ynbZnV4CwABBOgDAAAE6AMAAFBLAR4DCgAAAAAAAIAhAAAAAAAAAAAAAAAAAAwAGAAAAAAAAQAAAKSBAAAAAC4uL2VzY2FwZS5weVVUBQAD8ynbZnV4CwABBOgDAAAE6AMAAFBLBQYAAAAAAQABAFIAAABGAAAAAAA=", "base64");
  await page.getByLabel("Workspace archive 파일").setInputFiles({ name: "unsafe.zip", mimeType: "application/zip", buffer: bytes });
  await expect(page.getByRole("alert")).toContainText("ARCHIVE_IMPORT_REJECTED");
  await expect(page.getByRole("dialog", { name: "외부 workspace 확인" })).toHaveCount(0);
});
