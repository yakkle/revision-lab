import { expect, test, type Page } from "@playwright/test";

async function command(page: Page, source: string, success = true) {
  await page.getByRole("textbox", { name: "Alembic 명령" }).fill(source);
  await page.getByRole("button", { name: "명령 실행", exact: true }).click();
  await expect(page.getByRole("button", { name: "명령 실행", exact: true })).toBeEnabled({ timeout: 45_000 });
  await expect(page.locator(".terminal-output > div").last()).toContainText(success ? "성공" : "실패");
}

for (const mode of ["SQLite", "PostgreSQL"] as const) {
  test(`${mode}: edits and runs real migrations through the Lab UI`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await page.getByRole("button", { name: mode + " 환경 선택", exact: true }).click();
    await page.getByRole("button", { name: "새 workspace 만들기", exact: true }).click();
    await expect(page.getByRole("button", { name: "명령 실행", exact: true })).toBeEnabled({ timeout: 100_000 });
    await command(page, "alembic init migrations");
    await expect(page.getByRole("navigation", { name: "Workspace 파일" }).getByRole("button", { name: "models.py", exact: true })).toBeVisible();
    await command(page, 'alembic revision -m "create users" --rev-id r1');
    const editor = page.locator(".cm-content");
    await expect(editor).toContainText("revision");
    await editor.fill(`from alembic import op
import sqlalchemy as sa
import time
revision = "r1"
down_revision = None
branch_labels = None
depends_on = None
def upgrade():
    time.sleep(2)
    users = op.create_table("users", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("name", sa.String(80)), sa.Column("large", sa.BigInteger()))
    op.bulk_insert(users, [{"id": i, "name": "user " + str(i), "large": 9007199254740993} for i in range(51)])
def downgrade():
    op.drop_table("users")
${Array.from({ length: 80 }, (_, index) => `# editor scroll verification line ${index + 1}`).join("\n")}
`);
    const scroller = page.locator(".code-editor .cm-scroller");
    const dimensions = await scroller.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "명령 실행", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "파일 저장", exact: true }).click();
    await expect(page.getByRole("button", { name: "명령 실행", exact: true })).toBeEnabled();
    await page.getByRole("textbox", { name: "Alembic 명령" }).fill("alembic upgrade head");
    await page.getByRole("button", { name: "명령 실행", exact: true }).click();
    await expect(page.getByRole("button", { name: "명령 실행", exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: "원본 로그", exact: true }).click();
    await expect(page.getByRole("tab", { name: "원본 로그", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "명령 실행", exact: true })).toBeEnabled({ timeout: 45_000 });
    await expect(page.locator(".terminal-output > div").last()).toContainText("성공");
    await page.getByRole("tab", { name: "Schema / Data", exact: true }).click();
    await expect(page.getByTestId("db-version")).toHaveText("r1");
    await page.getByRole("button", { name: "users", exact: true }).click();
    await expect(page.getByRole("table", { name: /users 실제 데이터/ })).toContainText("9007199254740993");
    await expect(page.getByRole("table", { name: /users 실제 데이터/ }).getByRole("row")).toHaveCount(51);
    await expect(page.getByText("users 실제 데이터 · 처음 50행 (추가 행 있음)")).toBeVisible();
    await page.getByRole("tab", { name: "Diff", exact: true }).click();
    await expect(page.locator("#panel-diff")).toContainText("table · users.users");
    await page.getByRole("button", { name: "DB 테이블 열기", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Schema / Data", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "r1 파일 열기", exact: true }).click();
    await expect(page.locator(".file-caption")).toContainText("r1_create_users.py");
    await command(page, "alembic downgrade -1");
    await page.getByRole("tab", { name: "Schema / Data", exact: true }).click();
    await expect(page.getByTestId("db-version")).toContainText("base");
    await expect(page.getByRole("button", { name: "users", exact: true })).toHaveCount(0);
    await command(page, "alembic upgrade head");
    await command(page, "alembic revision -m alice --rev-id a1");
    await command(page, "alembic revision -m bob --head r1 --splice --rev-id b1");
    await command(page, "alembic upgrade head", false);
    await expect(page.getByRole("alert")).toContainText("Multiple head revisions");
    await page.getByRole("tab", { name: "Revision DAG", exact: true }).click();
    await expect(page.getByRole("list", { name: "Revision 목록" })).toContainText("a1");
    await expect(page.getByRole("list", { name: "Revision 목록" })).toContainText("b1");
    await command(page, "alembic merge a1 b1 -m merge --rev-id m1");
    await command(page, "alembic upgrade head");
    await page.getByRole("tab", { name: "Schema / Data", exact: true }).click();
    await expect(page.getByTestId("db-version")).toHaveText("m1");
    await command(page, "alembic heads | cat", false);
    await expect(page.getByRole("alert")).toContainText("UNSUPPORTED_SHELL_SYNTAX");
    await page.getByRole("tab", { name: "원본 로그", exact: true }).click();
    await expect(page.locator("#panel-logs")).toContainText("MultipleHeads");
    await expect(page.getByRole("complementary", { name: "학습 설명" })).toBeVisible();
    await page.getByRole("button", { name: "Workspace 초기화" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "취소", exact: true }).click();
    await page.getByRole("tab", { name: "Schema / Data", exact: true }).click();
    await expect(page.getByTestId("db-version")).toHaveText("m1");
    await page.getByRole("button", { name: "Workspace 초기화" }).click();
    await page.getByRole("button", { name: "파일·DB 삭제 후 초기화", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(/준비됨|실행기 중단/, { timeout: 100_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "명령 실행", exact: true })).toBeEnabled({ timeout: 100_000 });
    await expect(page.getByTestId("db-version")).toContainText("base");
    await expect(page.getByRole("navigation", { name: "Workspace 파일" }).getByRole("button")).toHaveCount(0);
    const retainedId = await page.getByRole("combobox", { name: "Workspace", exact: true }).inputValue();
    await command(page, "alembic init migrations");
    await page.getByRole("button", { name: "새 workspace 만들기", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(/준비됨|실행기 중단/, { timeout: 100_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Workspace 파일" }).getByRole("button")).toHaveCount(0);
    await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(retainedId);
    await expect(page.getByRole("navigation", { name: "Workspace 파일" }).getByRole("button", { name: "models.py", exact: true })).toBeVisible();
  });
}

test("narrow layout switches panels using only the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/");
  const editor = page.getByRole("tab", { name: "파일 / 코드", exact: true });
  await editor.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Revision DAG", exact: true })).toBeFocused();
  await expect(page.locator("#panel-editor")).toBeHidden();
  await expect(page.locator(".inspector-panel")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(editor).toBeFocused();
  await expect(page.locator("#panel-editor")).toBeVisible();
  await expect(page.locator(".inspector-panel")).toBeHidden();
});
