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
  });

  it("allows an available PostgreSQL environment to be selected", async () => {
    vi.spyOn(capabilityModule, "detectRuntimeCapabilities").mockReturnValue(readyCapabilities);
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "PostgreSQL 환경 선택" }));

    expect(screen.getByText("선택된 환경:")).toHaveTextContent("PostgreSQL");
  });

  it("disables PostgreSQL and explains missing isolation capabilities", () => {
    vi.spyOn(capabilityModule, "detectRuntimeCapabilities").mockReturnValue({
      ...readyCapabilities,
      postgresqlAvailable: false,
      postgresqlBlockers: ["Cross-origin isolation", "SharedArrayBuffer"],
    });

    render(<App />);

    expect(screen.getByRole("button", { name: "PostgreSQL 환경 선택" })).toBeDisabled();
    expect(screen.getByText(/필요한 기능:/)).toHaveTextContent(
      "Cross-origin isolation, SharedArrayBuffer",
    );
  });

  it("shows a practical SQLAlchemy 2.x User model in the autogenerate guide", async () => {
    vi.spyOn(capabilityModule, "detectRuntimeCapabilities").mockReturnValue(readyCapabilities);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "학습 가이드 열기" }));
    await user.click(screen.getByRole("tab", { name: /autogenerate 검토/ }));
    expect(screen.getByLabelText("models.py 예제 코드")).toHaveTextContent("class User(Base)");
    expect(screen.getByLabelText("models.py 예제 코드")).toHaveTextContent("metadata = Base.metadata");
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
