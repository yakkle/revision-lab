import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as capabilityModule from "./capabilities/detect-runtime-capabilities";
import { createLab } from "./lab/store";
import { emptyLessonEvidence } from "./lessons/lessons";

const readyCapabilities: capabilityModule.RuntimeCapabilities = {
  checks: [
    {
      key: "crossOriginIsolated",
      label: "Cross-origin isolation",
      supported: true,
      description: "테스트 진단",
    },
  ],
  sqliteAvailable: true,
  postgresqlAvailable: true,
  postgresqlBlockers: [],
};

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    HTMLDialogElement.prototype.close = function close() { this.open = false; };
  });

  it("creates an available PostgreSQL workspace directly", async () => {
    vi.spyOn(capabilityModule, "detectRuntimeCapabilities").mockReturnValue(readyCapabilities);
    const user = userEvent.setup();
    const lab = createLab();
    const create = vi.spyOn(lab, "create").mockResolvedValue(undefined);
    render(<App controller={lab} />);

    await user.click(screen.getAllByRole("button", { name: "PostgreSQL workspace 만들기" })[0]);

    expect(create).toHaveBeenCalledWith("postgresql");
  });

  it("disables PostgreSQL and explains missing isolation capabilities", async () => {
    vi.spyOn(capabilityModule, "detectRuntimeCapabilities").mockReturnValue({
      ...readyCapabilities,
      postgresqlAvailable: false,
      postgresqlBlockers: ["Cross-origin isolation", "SharedArrayBuffer"],
    });

    const user = userEvent.setup();
    render(<App />);

    expect(screen.getAllByRole("button", { name: "PostgreSQL workspace 만들기" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ disabled: true }),
    ]));
    await user.click(screen.getByRole("button", { name: "Workspace 관리" }));
    expect(screen.getAllByText(/필요한 기능:/)[0]).toHaveTextContent(
      "Cross-origin isolation, SharedArrayBuffer",
    );
  });

  it("shows a practical SQLAlchemy 2.x User model in the autogenerate guide", async () => {
    vi.spyOn(capabilityModule, "detectRuntimeCapabilities").mockReturnValue(readyCapabilities);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "학습 가이드 열기" }));
    await user.click(screen.getByRole("tab", { name: /autogenerate 검토/ }));
    expect(screen.getByLabelText("models.py 예제 코드")).toHaveTextContent("email: Mapped[str | None]");
    expect(screen.getByLabelText("models.py 예제 코드")).not.toHaveTextContent("class User(Base)");
  });

  it("stages a guide command in the terminal without running it", async () => {
    vi.spyOn(capabilityModule, "detectRuntimeCapabilities").mockReturnValue(readyCapabilities);
    const user = userEvent.setup();
    const lab = createLab();
    const run = vi.spyOn(lab, "run");
    render(<App controller={lab} />);

    await user.click(screen.getByRole("button", { name: "학습 가이드 열기" }));
    await user.click(screen.getByRole("button", { name: "alembic init migrations 터미널에 입력" }));

    expect(screen.getByRole("textbox", { name: "Alembic 명령" })).toHaveValue("alembic init migrations");
    expect(screen.getByRole("textbox", { name: "Alembic 명령" })).toHaveFocus();
    expect(run).not.toHaveBeenCalled();
  });

  it("dismisses top-level popovers with outside clicks and Escape while keeping inside disclosures open", async () => {
    vi.spyOn(capabilityModule, "detectRuntimeCapabilities").mockReturnValue(readyCapabilities);
    const user = userEvent.setup();
    render(<App />);

    const workspaceTrigger = screen.getByRole("button", { name: "Workspace 관리" });
    await user.click(workspaceTrigger);
    await user.click(screen.getByText("이 브라우저의 실습 환경"));
    expect(workspaceTrigger).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("main"));
    expect(workspaceTrigger).toHaveAttribute("aria-expanded", "false");

    const commandTrigger = screen.getByRole("button", { name: "명령 예시" });
    await user.click(workspaceTrigger);
    await user.click(commandTrigger);
    expect(workspaceTrigger).toHaveAttribute("aria-expanded", "false");
    expect(commandTrigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(commandTrigger).toHaveAttribute("aria-expanded", "false");
    expect(commandTrigger).toHaveFocus();
  });

  it("confirms permanent workspace deletion and explains how to free collaboration capacity", async () => {
    vi.spyOn(capabilityModule, "detectRuntimeCapabilities").mockReturnValue(readyCapabilities);
    const user = userEvent.setup();
    const lab = createLab();
    lab.store.setState({ activeId: "second", guideEnabled: true, activeLesson: "collaboration", workspaces: [
      { id: "first", name: "SQLite 1", mode: "sqlite", drafts: {}, entries: [], changes: [], broken: false, stale: false, evidence: emptyLessonEvidence() },
      { id: "second", name: "PostgreSQL 2", mode: "postgresql", drafts: {}, entries: [], changes: [], broken: false, stale: false, evidence: emptyLessonEvidence() },
    ] });
    const removeWorkspace = vi.spyOn(lab, "removeWorkspace").mockResolvedValue(undefined);
    render(<App controller={lab} />);

    expect(screen.getByText(/Base, Alice, Bob, Integration의 4개 workspace/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Workspace 관리 열기" }));
    expect(screen.getByRole("button", { name: "Workspace 관리" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Workspace 삭제" }));
    expect(screen.getByRole("dialog", { name: "Workspace를 삭제할까요?" })).toHaveTextContent("PostgreSQL 2");
    await user.click(screen.getByRole("button", { name: "Workspace 완전히 삭제" }));
    expect(removeWorkspace).toHaveBeenCalledOnce();
  });

  it("maximizes and restores the editor with the toggle and Escape", async () => {
    vi.spyOn(capabilityModule, "detectRuntimeCapabilities").mockReturnValue(readyCapabilities);
    const user = userEvent.setup();
    render(<App />);
    const shell = document.querySelector(".app-shell")!;

    await user.click(screen.getByRole("button", { name: "편집기 최대화" }));
    expect(shell).toHaveClass("editor-maximized");
    expect(screen.getByRole("button", { name: "기본 크기로 복원" })).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Escape}");
    expect(shell).not.toHaveClass("editor-maximized");
    expect(screen.getByRole("button", { name: "편집기 최대화" })).toHaveFocus();
  });

  it("offers an explicit checkpoint retry when automatic recovery did not complete", () => {
    vi.spyOn(capabilityModule, "detectRuntimeCapabilities").mockReturnValue(readyCapabilities);
    const lab = createLab();
    lab.store.setState({ activeId: "broken", workspaces: [{ id: "broken", name: "SQLite 1", mode: "sqlite",
      drafts: {}, entries: [], changes: [], broken: true, stale: true,
      evidence: emptyLessonEvidence(),
      error: { code: "ALEMBIC_COMMAND_TIMEOUT", message: "RUN_COMMAND exceeded 30000 ms", traceback: "original trace" },
    }] });
    render(<App controller={lab} />);
    expect(screen.getByRole("alert")).toHaveTextContent("자동 복원이 완료되지 않았습니다");
    expect(screen.getByRole("button", { name: "명령 실행" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "체크포인트 복원 다시 시도" })).toBeEnabled();
  });
});
