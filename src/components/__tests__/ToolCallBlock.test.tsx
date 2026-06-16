// ---------------------------------------------------------------------------
// Tests for ToolCallBlock component
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
    },
    {
      name: "read_file",
      arguments: '{"path": "/src/main.rs"}',
      result_snippet: 'fn main() { println!("Hello"); }',
    },
  ];

  it("renders tool call count", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
  });

  it("renders singular 'tool call' for single item", () => {
    render(<ToolCallBlock calls={[mockCalls[0]]} />);
    expect(screen.getByText("1 tool call")).toBeInTheDocument();
  });

  it("shows tool names in the header", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    expect(screen.getByText("web_fetch, read_file")).toBeInTheDocument();
  });

  it("is collapsed by default", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    expect(screen.queryByText("Fetched 12345 bytes")).not.toBeInTheDocument();
    expect(screen.queryByText('fn main() { println!("Hello"); }')).not.toBeInTheDocument();
  });

  it("expands when clicked", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    fireEvent.click(screen.getByText("2 tool calls"));
    expect(screen.getByText("Fetched 12345 bytes")).toBeInTheDocument();
    expect(screen.getByText('fn main() { println!("Hello"); }')).toBeInTheDocument();
  });

  it("collapses when clicked again", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    fireEvent.click(screen.getByText("2 tool calls"));
    expect(screen.getByText("Fetched 12345 bytes")).toBeInTheDocument();

    fireEvent.click(screen.getByText("2 tool calls"));
    expect(screen.queryByText("Fetched 12345 bytes")).not.toBeInTheDocument();
  });

  it("renders individual tool call details when expanded", () => {
    render(<ToolCallBlock calls={mockCalls} />);
    fireEvent.click(screen.getByText("2 tool calls"));

    // Tool names should be visible
    expect(screen.getByText("web_fetch")).toBeInTheDocument();
    expect(screen.getByText("read_file")).toBeInTheDocument();

    // Arguments as code
    expect(screen.getByText('{"url": "https://example.com"}')).toBeInTheDocument();
    expect(screen.getByText('{"path": "/src/main.rs"}')).toBeInTheDocument();
  });

  it("renders empty state when calls array is empty", () => {
    render(<ToolCallBlock calls={[]} />);
    expect(screen.getByText("0 tool calls")).toBeInTheDocument();
    expect(screen.getByText("0 tool calls")).toBeInTheDocument();
  });
});
