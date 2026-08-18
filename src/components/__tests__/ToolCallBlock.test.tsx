// ---------------------------------------------------------------------------
// Tests for ToolCallBlock component (collapsible tool-call windows)
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallBlock } from "../ChatPanel";
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
