import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as capabilityModule from "./capabilities/detect-runtime-capabilities";

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

    expect(screen.getByText("선택된 환경:").parentElement).toHaveTextContent("PostgreSQL");
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
});
