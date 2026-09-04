// ---------------------------------------------------------------------------
// Tests for ToolCallBlock component (collapsible tool-call windows)
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallBlock, LiveToolCallItem } from "../ChatPanel";
import type { ToolCallLog } from "../ChatPanel";

describe("ToolCallBlock", () => {
  const mockCalls: ToolCallLog[] = [
    {
      name: "web_fetch",
      arguments: '{"url": "https://example.com"}',
      result_snippet: "Fetched 12345 bytes",
      result_full: "Fetched 12345 bytes from https://example.com",
    },
    {
      name: "read_file",
      arguments: '{"path": "/src/main.rs"}',
      result_snippet: 'fn main() { println!("Hello"); }',
      result_full: 'fn main() {\n    println!("Hello");\n}',
    },
  ];

  it("renders a window per tool call with its name", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    expect(screen.getByText("web_fetch")).toBeInTheDocument();
    expect(screen.getByText("read_file")).toBeInTheDocument();
  });

  it("shows the argument summary in each header", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    // web_fetch summarizes to its url; read_file to its path.
    expect(screen.getByText("https://example.com")).toBeInTheDocument();
    expect(screen.getByText("/src/main.rs")).toBeInTheDocument();
  });

  it("is collapsed by default (results hidden)", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    expect(screen.queryByText("Fetched 12345 bytes from https://example.com")).not.toBeInTheDocument();
    expect(screen.queryByText('fn main() {\n    println!("Hello");\n}')).not.toBeInTheDocument();
  });

  it("expands when clicked", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    fireEvent.click(screen.getByText("web_fetch"));
    expect(screen.getByText("Fetched 12345 bytes from https://example.com")).toBeInTheDocument();
  });

  it("collapses when clicked again", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    fireEvent.click(screen.getByText("web_fetch"));
    expect(screen.getByText("Fetched 12345 bytes from https://example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByText("web_fetch"));
    expect(screen.queryByText("Fetched 12345 bytes from https://example.com")).not.toBeInTheDocument();
  });

  it("shows pretty-printed arguments when expanded", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    fireEvent.click(screen.getByText("read_file"));
    expect(screen.getByText((content) => content.includes('"/src/main.rs"'))).toBeInTheDocument();
  });

  it("renders empty state when calls array is empty", () => {
    render(<ToolCallBlock calls={[]} />);
    expect(screen.queryByText("web_fetch")).not.toBeInTheDocument();
  });
});

describe("LiveToolCallItem", () => {
  it("renders a collapsed window with the tool name and running status", () => {
    render(
      <LiveToolCallItem
        call={{ name: "read_file", status: "start", path: "/src/main.rs", arguments: '{"path":"/src/main.rs"}' }}
      />,
    );
    expect(screen.getByText("read_file")).toBeInTheDocument();
    expect(screen.getByText(/running/)).toBeInTheDocument();
    // Output is not shown while the tool is still running.
    expect(screen.queryByText("Output")).not.toBeInTheDocument();
  });

  it("expands while running to show the tool input clearly separated", () => {
    render(
      <LiveToolCallItem
        call={{ name: "read_file", status: "start", path: "/src/main.rs", arguments: '{"path":"/src/main.rs"}' }}
      />,
    );
    fireEvent.click(screen.getByText("read_file"));
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText((c) => c.includes('"/src/main.rs"'))).toBeInTheDocument();
    expect(screen.getByText(/output appears when the tool finishes/i)).toBeInTheDocument();
  });

  it("expands when done to show input and output as separate sections", () => {
    render(
      <LiveToolCallItem
        call={{
          name: "read_file",
          status: "done",
          path: "/src/main.rs",
          arguments: '{"path":"/src/main.rs"}',
          result: "fn main() {}",
        }}
      />,
    );
    fireEvent.click(screen.getByText("read_file"));
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("fn main() {}")).toBeInTheDocument();
  });

  it("shows the error output for a failed tool call", () => {
    render(
      <LiveToolCallItem
        call={{
          name: "write_file",
          status: "error",
          arguments: '{"path":"/x"}',
          result: "Tool error: permission denied",
        }}
      />,
    );
    expect(screen.getByText("error")).toBeInTheDocument();
    fireEvent.click(screen.getByText("write_file"));
    expect(screen.getByText("Tool error: permission denied")).toBeInTheDocument();
  });
});
