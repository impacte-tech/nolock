import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import McpConnections from "../McpConnections";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("saves a remote connection only to the selected project", async () => {
  vi.mocked(invoke).mockResolvedValue({mcpServers:{}});
  render(<McpConnections rootPath="/project-a" />);
  await screen.findByText("No connections yet. Add a server to get started.");
  fireEvent.click(screen.getByText("Add MCP server"));
  fireEvent.change(screen.getByLabelText("Server name"), {target:{value:"docs"}});
  fireEvent.change(screen.getByLabelText("Server URL"), {target:{value:"https://example.com/mcp"}});
  fireEvent.click(screen.getByText("Save connection"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_mcp_servers", {rootPath:"/project-a",config:{mcpServers:{docs:{url:"https://example.com/mcp",headers:{},disabled:false}}}}));
  expect(await screen.findByRole("status")).toHaveTextContent("Restart running agents");
  expect(screen.getByText("Enabled", {exact:false})).toBeInTheDocument();
});
it("disables and removes saved connections without changing others", async () => {
  vi.mocked(invoke).mockResolvedValue({mcpServers:{docs:{url:"https://example.com/mcp"},local:{command:"tool"}}});
  render(<McpConnections rootPath="/project" />);
  fireEvent.click(await screen.findByRole("button", {name:"Disable docs"}));
  await screen.findByRole("button", {name:"Enable docs"});
  expect(invoke).toHaveBeenLastCalledWith("save_mcp_servers", {rootPath:"/project",config:{mcpServers:{docs:{url:"https://example.com/mcp",disabled:true},local:{command:"tool"}}}});
  fireEvent.click(screen.getByRole("button", {name:"Remove docs"}));
  await waitFor(() => expect(screen.queryByRole("button", {name:"Edit docs"})).not.toBeInTheDocument());
  expect(screen.getByRole("button", {name:"Edit local"})).toBeInTheDocument();
});
it("keeps the editor and saved list intact when persistence fails", async () => {
  vi.mocked(invoke).mockImplementation(async cmd => {if(cmd === "save_mcp_servers") throw "Settings file unavailable"; return {mcpServers:{}};});
  render(<McpConnections rootPath="/project" />);
  await screen.findByText("No connections yet. Add a server to get started.");
  fireEvent.click(screen.getByText("Add MCP server"));
  fireEvent.change(screen.getByLabelText("Server name"), {target:{value:"docs"}});
  fireEvent.change(screen.getByLabelText("Server URL"), {target:{value:"https://example.com/mcp"}});
  fireEvent.click(screen.getByText("Save connection"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings file unavailable");
  expect(screen.getByLabelText("Server name")).toHaveValue("docs");
  expect(screen.queryByRole("button", {name:"Edit docs"})).not.toBeInTheDocument();
});

it("uses plain fields for local arguments and environment values", async () => {
  vi.mocked(invoke).mockResolvedValue({mcpServers:{}});
  render(<McpConnections rootPath="/project"/>);
  await screen.findByText("No connections yet. Add a server to get started.");
  fireEvent.click(screen.getByText("Add MCP server"));
  fireEvent.change(screen.getByLabelText("Server name"), {target:{value:"local"}});
  fireEvent.change(screen.getByLabelText("Connection type"), {target:{value:"stdio"}});
  fireEvent.change(screen.getByLabelText("Command"), {target:{value:"npx"}});
  fireEvent.change(screen.getByLabelText("Arguments (one per line)"), {target:{value:"-y\nmy-package\n/path with spaces"}});
  fireEvent.click(screen.getByText("Add variable"));
  fireEvent.change(screen.getByLabelText("Setting 1 name"), {target:{value:"API_KEY"}});
  fireEvent.change(screen.getByLabelText("Setting 1 value"), {target:{value:"fixture"}});
  fireEvent.click(screen.getByText("Save connection"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_mcp_servers", {rootPath:"/project",config:{mcpServers:{local:{command:"npx",args:["-y","my-package","/path with spaces"],env:{API_KEY:"fixture"},disabled:false}}}}));
});
it("rejects malformed URLs without writing configuration", async () => {
  vi.mocked(invoke).mockResolvedValue({mcpServers:{}});
  render(<McpConnections rootPath="/project"/>);
  await screen.findByText("No connections yet. Add a server to get started.");
  fireEvent.click(screen.getByText("Add MCP server"));
  fireEvent.change(screen.getByLabelText("Server name"), {target:{value:"remote"}});
  fireEvent.change(screen.getByLabelText("Server URL"), {target:{value:"not a URL"}});
  fireEvent.click(screen.getByText("Save connection"));
  expect(await screen.findByRole("alert")).toHaveTextContent("complete server URL");
  expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "save_mcp_servers")).toBe(false);
});
it("ignores a late settings response from the previous project", async () => {
  let oldResult!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation((_, args: any) => args.rootPath === "/old" ? new Promise(resolve => { oldResult = resolve; }) : Promise.resolve({mcpServers:{fresh:{url:"https://example.com/mcp"}}}));
  const {rerender} = render(<McpConnections rootPath="/old"/>);
  rerender(<McpConnections rootPath="/new"/>);
  await screen.findByRole("button", {name:"Edit fresh"});
  oldResult({mcpServers:{stale:{url:"https://example.com/mcp"}}});
  await waitFor(() => expect(screen.queryByRole("button", {name:"Edit stale"})).not.toBeInTheDocument());
  expect(screen.getByRole("button", {name:"Edit fresh"})).toBeInTheDocument();
});
