import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import AgentUsage from "../AgentUsage";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("groups models under agents without adding cache or reasoning twice", async () => {
  vi.mocked(invoke).mockResolvedValue({ sessions: 3, sessionsWithoutUsage: 1, warnings: [], rows: [
    { agent: "Codex", provider: "local", model: "alpha", sessions: 1, inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, cacheWriteTokens: 0, reasoningTokens: 5 },
    { agent: "Codex", provider: "local", model: "beta", sessions: 1, inputTokens: 30, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  ] });
  render(<AgentUsage rootPath="/project" />);
  expect(await screen.findByText("Codex · 160 tokens")).toBeInTheDocument();
  expect(screen.getByText("3 native sessions · 1 without reported usage")).toBeInTheDocument();
  expect(screen.getByText("alpha")).toBeInTheDocument();
  expect(screen.getByText("beta")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Refresh usage"));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
});
it("reports unavailable data instead of a zero total", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("unreadable"));
  render(<AgentUsage rootPath="/project" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not read native agent usage");
  expect(screen.queryByText(/0 tokens/)).not.toBeInTheDocument();
});
