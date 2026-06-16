// ---------------------------------------------------------------------------
// Tests for MarkdownContent component
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownContent } from "../ChatPanel";

describe("MarkdownContent", () => {
  it("renders plain text", () => {
    render(<MarkdownContent text="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders bold text", () => {
    render(<MarkdownContent text="This is **bold** text" />);
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });

  it("renders italic text", () => {
    render(<MarkdownContent text="This is *italic* text" />);
    expect(screen.getByText("italic")).toBeInTheDocument();
    expect(screen.getByText("italic").tagName).toBe("EM");
  });

  it("renders inline code", () => {
    render(<MarkdownContent text="Use the `foo()` function" />);
    const codeEl = screen.getByText("foo()");
    expect(codeEl).toBeInTheDocument();
    expect(codeEl.tagName).toBe("CODE");
  });

  it("renders code blocks", () => {
    render(<MarkdownContent text={"```javascript\nconst x = 1;\n```"} />);
    const codeEl = screen.getByText("const x = 1;");
    expect(codeEl).toBeInTheDocument();
    expect(codeEl.tagName).toBe("CODE");
  });

  it("renders links", () => {
    render(<MarkdownContent text="[Click here](https://example.com)" />);
    const link = screen.getByText("Click here");
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  it("renders headers", () => {
    render(<MarkdownContent text={"# Big Title\n## Sub Title"} />);
    expect(screen.getByText("Big Title")).toBeInTheDocument();
    expect(screen.getByText("Big Title").tagName).toBe("H1");
    expect(screen.getByText("Sub Title")).toBeInTheDocument();
    expect(screen.getByText("Sub Title").tagName).toBe("H2");
  });

  it("renders unordered lists", () => {
    render(<MarkdownContent text={"- Item 1\n- Item 2\n- Item 3"} />);
    expect(screen.getByText("Item 1")).toBeInTheDocument();
    expect(screen.getByText("Item 2")).toBeInTheDocument();
    expect(screen.getByText("Item 3")).toBeInTheDocument();
  });

  it("renders ordered lists", () => {
    render(<MarkdownContent text={"1. First\n2. Second\n3. Third"} />);
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.getByText("Third")).toBeInTheDocument();
  });

  it("renders blockquotes", () => {
    render(<MarkdownContent text={"> This is a quote"} />);
    expect(screen.getByText("This is a quote")).toBeInTheDocument();
    const blockquote = screen.getByText("This is a quote").closest("blockquote");
    expect(blockquote).toBeInTheDocument();
  });

  it("renders tables", () => {
    render(<MarkdownContent text={"| A | B |\n|---|---|\n| 1 | 2 |"} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders horizontal rules", () => {
    const { container } = render(<MarkdownContent text={"---"} />);
    expect(container.querySelector("hr")).toBeInTheDocument();
  });

  it("renders empty string safely", () => {
    const { container } = render(<MarkdownContent text="" />);
    expect(container.querySelector(".chat-markdown")).toBeInTheDocument();
  });

  it("handles mixed formatting", () => {
    render(
      <MarkdownContent text="Hello **world**, this is *great* and `code` works!" />,
    );
    expect(screen.getByText("world").tagName).toBe("STRONG");
    expect(screen.getByText("great").tagName).toBe("EM");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });
});
