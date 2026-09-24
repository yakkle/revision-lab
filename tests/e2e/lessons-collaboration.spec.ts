import { expect, test, type Page } from "@playwright/test";
import { MANUAL_USER_MIGRATION_EXAMPLE, SQLALCHEMY_USER_MODEL_EXAMPLE } from "../../src/lessons/lessons";

async function runCommand(page: Page, source: string, success = true) {
  const input = page.getByRole("textbox", { name: "Alembic 명령" });
  await input.fill(source);
  const run = page.getByRole("button", { name: "명령 실행", exact: true });
  await run.click();
  await expect(run).toBeDisabled();
  await expect(run).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator(".terminal-output > div").last()).toContainText(success ? "성공" : "실패");
}

async function selectLesson(page: Page, title: RegExp) {
  await page.getByRole("tab", { name: title }).click();
}

for (const mode of ["SQLite", "PostgreSQL"] as const) {
  test(`${mode}: completes all lessons and the real Alice/Bob integration flow`, async ({ page }) => {
    test.setTimeout(420_000);
    await page.goto("/");
    await page.getByRole("button", { name: `${mode} workspace 만들기`, exact: true }).click();
    await expect(page.getByRole("button", { name: "명령 실행", exact: true })).toBeEnabled({
      timeout: 100_000,
    });
    await page.getByRole("button", { name: "학습 가이드 열기" }).click();

    const entriesBefore = await page.locator(".terminal-output > div").count();
    await page.getByRole("button", { name: "alembic init migrations 터미널에 입력", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Alembic 명령" })).toBeFocused();
    expect(await page.locator(".terminal-output > div").count()).toBe(entriesBefore);
    await page.getByRole("button", { name: "명령 실행", exact: true }).click();
    await expect(page.getByRole("button", { name: "명령 실행", exact: true })).toBeEnabled({
      timeout: 60_000,
    });
    await expect(page.locator(".terminal-output > div").last()).toContainText("성공");
    await expect(page.locator(".lesson-checks")).toContainText("2 / 2");

    await selectLesson(page, /수동 revision/);
    await runCommand(page, 'alembic revision -m "common base" --rev-id root1');
    await page.locator(".cm-content").fill(`from alembic import op
import sqlalchemy as sa

revision = "root1"
down_revision = None
branch_labels = None
depends_on = None

${MANUAL_USER_MIGRATION_EXAMPLE}`);
    await page.getByRole("button", { name: "파일 저장", exact: true }).click();
    await expect(page.locator(".lesson-checks")).toContainText("3 / 3");

    await selectLesson(page, /upgrade와 downgrade/);
    await runCommand(page, "alembic upgrade head");
    await runCommand(page, "alembic downgrade -1");
    await runCommand(page, "alembic upgrade head");
    await expect(page.locator(".lesson-checks")).toContainText("3 / 3");

    await page
      .getByRole("navigation", { name: "Workspace 파일" })
      .getByRole("button", { name: "models.py", exact: true })
      .click();
    await page.waitForFunction(() => !document.querySelector(".code-editor")?.hasAttribute("inert"));
    await expect(page.locator(".cm-content")).toContainText("# email: Mapped[str | None]");
    await page.locator(".cm-content").fill(SQLALCHEMY_USER_MODEL_EXAMPLE);
    await page.getByRole("button", { name: "파일 저장", exact: true }).click();
    await selectLesson(page, /autogenerate 검토/);
    await runCommand(page, 'alembic revision --autogenerate -m "add email" --rev-id model1');
    await expect(page.locator(".cm-content")).toContainText("add_column");
    await expect(page.locator(".cm-content")).not.toContainText("create_table");
    await runCommand(page, "alembic upgrade head");
    await expect(page.locator(".lesson-checks")).toContainText("3 / 3");
    await page.getByRole("tab", { name: "Schema / Data", exact: true }).click();
    await page.getByRole("button", { name: "users", exact: true }).click();
    await expect(page.getByRole("table", { name: /컬럼/ })).toContainText("email");
    await expect(page.getByRole("table", { name: /컬럼/ })).toContainText("name");

    await selectLesson(page, /Alice \/ Bob branch와 merge/);
    await page.getByRole("button", { name: "공통 base에서 협업 환경 만들기" }).click();
    await expect(page.getByRole("button", { name: "Alice branch", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 180_000 },
    );
    await runCommand(page, 'alembic revision -m "Alice change" --rev-id alice');
    await page.getByRole("button", { name: "Bob branch", exact: true }).click();
    await runCommand(page, 'alembic revision -m "Bob change" --rev-id bob');
    await page.getByRole("button", { name: "Alice · Bob PR 파일 합치기" }).click();
    await expect(page.getByRole("button", { name: "PR 파일 합침 완료" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole("list", { name: "Revision 목록" })).toContainText("alice");
    await expect(page.getByRole("list", { name: "Revision 목록" })).toContainText("bob");

    await runCommand(page, "alembic upgrade head", false);
    await expect(page.getByRole("alert")).toContainText("Multiple head revisions");
    await runCommand(page, 'alembic merge alice bob -m "merge Alice and Bob" --rev-id merged');
    await runCommand(page, "alembic upgrade head");
    await expect(page.locator(".lesson-checks")).toContainText("7 / 7");
    await page.getByRole("tab", { name: "Schema / Data", exact: true }).click();
    await expect(page.getByTestId("db-version")).toHaveText("merged");
  });
}
