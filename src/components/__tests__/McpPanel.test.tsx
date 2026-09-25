import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import McpPanel from "../McpPanel";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("offers project MCPs and session tracking without a broker or secrets UI", async () => {
  vi.mocked(invoke).mockResolvedValue({mcpServers:{}});
  render(<McpPanel visible onClose={vi.fn()} rootPath="/project" />);
  expect(await screen.findByText("Add MCP server")).toBeInTheDocument();
  expect(screen.getByText("Agent sessions")).toBeInTheDocument();
  expect(screen.queryByText("Secrets Broker")).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("list_mcp_servers", {rootPath:"/project"});
});
it("asks for a project before configuring MCP", () => {
  render(<McpPanel visible onClose={vi.fn()} rootPath="" />);
  expect(screen.getByText("Open a project to configure its MCP servers.")).toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();
});
