// ---------------------------------------------------------------------------
// Unit tests for FITM utility functions (pure, no mocks needed)
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  buildAiPrompt,
  extractCodeFromResponse,
  scoreCodeQuality,
  truncateAtLogicalBoundary,
  processCompletionResponse,
} from "../fitm";

// ===========================================================================
// buildAiPrompt
// ===========================================================================

describe("buildAiPrompt", () => {
  it("wraps prefix and suffix with FIM tokens", () => {
    const result = buildAiPrompt("function hello() ", '{\n  console.log("world");\n}');
    expect(result).toBe(
      '<|fim_prefix|>function hello() <|fim_suffix|>{\n  console.log("world");\n}<|fim_middle|>',
    );
  });

  it("returns raw prefix when suffix is null", () => {
    const result = buildAiPrompt("const x = 42;", null);
    expect(result).toBe("const x = 42;");
  });

  it("returns raw prefix when suffix is empty string", () => {
    const result = buildAiPrompt("const x = 42;", "");
    expect(result).toBe("const x = 42;");
  });

  it("returns raw prefix when suffix is whitespace-only", () => {
    const result = buildAiPrompt("const x = 42;", "   \n  ");
    expect(result).toBe("const x = 42;");
  });

  it("truncates prefix to 4000 chars", () => {
    const longPrefix = "x".repeat(5000);
    const suffix = "bar";
    const result = buildAiPrompt(longPrefix, suffix);
    // 4000 chars inside FIM tokens
    expect(result).toBe(
      `<|fim_prefix|>${"x".repeat(4000)}<|fim_suffix|>bar<|fim_middle|>`,
    );
    expect(result.length).toBeLessThan(4100);
  });

  it("preserves short prefix (< 4000) without truncation", () => {
    const prefix = "short";
    const result = buildAiPrompt(prefix, null);
    expect(result).toBe("short");
  });
});

// ===========================================================================
// extractCodeFromResponse
// ===========================================================================

describe("extractCodeFromResponse", () => {
  it("extracts code from markdown code blocks", () => {
    const input = "```python\nprint('hello world')\n```";
    expect(extractCodeFromResponse(input)).toBe("print('hello world')");
  });

  it("extracts code from code blocks with language specifier", () => {
    const input = "```typescript\nconst x: number = 42;\n```";
    expect(extractCodeFromResponse(input)).toBe("const x: number = 42;");
  });

  it("extracts code from the first code block when multiple exist", () => {
    const input = "```js\nconst a = 1;\n```\nSome text\n```py\nb = 2\n```";
    expect(extractCodeFromResponse(input)).toBe("const a = 1;");
  });

  it("passes through plain code unchanged", () => {
    const input = "const x = 42;";
    expect(extractCodeFromResponse(input)).toBe("const x = 42;");
  });

  it("strips conversational preamble: 'Here is the code:'", () => {
    const input = "Here is the code you requested:\n\nfunction add(a, b) {\n  return a + b;\n}";
    const result = extractCodeFromResponse(input);
    expect(result).toBe("function add(a, b) {\n  return a + b;\n}");
    expect(result).not.toMatch(/^Here is/i);
  });

  it("strips conversational preamble: 'Sure! Here's'", () => {
    const input = "Sure! Here's a function that does that:\n\ndef hello():\n    print('world')";
    const result = extractCodeFromResponse(input);
    expect(result).toBe("def hello():\n    print('world')");
  });

  it("strips conversational preamble: 'Let me provide'", () => {
    const input = "Let me provide the solution:\n\nconst result = data.map(x => x * 2);";
    const result = extractCodeFromResponse(input);
    expect(result).toBe("const result = data.map(x => x * 2);");
  });

  it("strips conversational preamble: 'I'll help you'", () => {
    const input = "I'll help you with that. Here is the code:\n\nrouter.get('/api', handler);";
    const result = extractCodeFromResponse(input);
    expect(result).toBe("router.get('/api', handler);");
  });

  it("strips trailing prose after blank line", () => {
    const input =
      "function fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n-1) + fibonacci(n-2);\n}\n\nThis function uses recursion to calculate the Fibonacci sequence.";
    const result = extractCodeFromResponse(input);
    expect(result).toBe(
      "function fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n-1) + fibonacci(n-2);\n}",
    );
    expect(result).not.toContain("This function uses recursion");
  });

  it("handles response that is ONLY conversational text (no code markers)", () => {
    const input =
      "Here is a function that calculates the sum of two numbers.";
    const result = extractCodeFromResponse(input);
    // The whole response is conversational - the preamble pattern matches the
    // entire string (the opening "Here is a function..." trigger), so it gets
    // fully stripped, leaving an empty result. This is correct behavior: no
    // code markers = nothing to extract.
    expect(result).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(extractCodeFromResponse("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(extractCodeFromResponse("   \n  \n  ")).toBe("");
  });

  it("handles code block with no trailing newline", () => {
    const input = "```\ncode line 1\ncode line 2\n```";
    expect(extractCodeFromResponse(input)).toBe("code line 1\ncode line 2");
  });

  it("preserves code with blank lines inside it", () => {
    const input = "function foo() {\n  const x = 1;\n\n  return x;\n}";
    const result = extractCodeFromResponse(input);
    expect(result).toBe("function foo() {\n  const x = 1;\n\n  return x;\n}");
  });

  it("does not strip code that has blank lines followed by code-like text", () => {
    const input =
      "const items = [1, 2, 3];\n\nitems.forEach(i => {\n  console.log(i);\n});";
    const result = extractCodeFromResponse(input);
    expect(result).toBe(input);
  });
});

// ===========================================================================
// scoreCodeQuality
// ===========================================================================

describe("scoreCodeQuality", () => {
  it("scores valid TypeScript code highly", () => {
    const code =
      "function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  return fibonacci(n-1) + fibonacci(n-2);\n}";
    const score = scoreCodeQuality(code);
    expect(score).toBeGreaterThanOrEqual(50);
  });

  it("scores valid Python code highly", () => {
    const code = "def hello(name: str) -> str:\n    return f'Hello {name}'";
    const score = scoreCodeQuality(code);
    expect(score).toBeGreaterThanOrEqual(50);
  });

  it("scores conversational prose low", () => {
    const prose =
      "Here is a function that calculates the Fibonacci sequence. It uses a recursive approach with two base cases.";
    const score = scoreCodeQuality(prose);
    expect(score).toBeLessThan(40);
  });

  it("scores empty string as 0", () => {
    expect(scoreCodeQuality("")).toBe(0);
  });

  it("scores single character as 0", () => {
    expect(scoreCodeQuality("a")).toBe(0);
  });

  it("scores markdown code block fences low", () => {
    const input = "```\ncode here\n```";
    const score = scoreCodeQuality(input);
    expect(score).toBeLessThan(40);
  });

  it("scores simple variable assignment highly", () => {
    const code = "const x = 42;";
    const score = scoreCodeQuality(code);
    expect(score).toBeGreaterThanOrEqual(50);
  });

  it("scores a function declaration highly", () => {
    const code = "function foo() {}";
    const score = scoreCodeQuality(code);
    expect(score).toBeGreaterThanOrEqual(50);
  });

  it("scores a class declaration highly", () => {
    const code = "class Foo {\n  constructor() {}\n}";
    const score = scoreCodeQuality(code);
    expect(score).toBeGreaterThanOrEqual(55);
  });

  it("scores chatty preamble + code with moderate score", () => {
    const input =
      "Sure! Here is the code:\n\nconst result = data.map(x => x * 2);";
    // The conversational start should lower the score but code patterns keep it moderate
    const score = scoreCodeQuality(input);
    expect(score).toBeGreaterThanOrEqual(30);
    expect(score).toBeLessThan(80);
  });
});

// ===========================================================================
// truncateAtLogicalBoundary
// ===========================================================================

describe("truncateAtLogicalBoundary", () => {
  it("returns text unchanged if under maxChars", () => {
    const text = "short;";
    expect(truncateAtLogicalBoundary(text, 256)).toBe("short;");
  });

  it("truncates at semicolon-newline boundary", () => {
    const text = "const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;";
    const result = truncateAtLogicalBoundary(text, 30);
    expect(result).toBe("const x = 1;\nconst y = 2;");
  });

  it("truncates at closing brace boundary", () => {
    const text =
      "function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}";
    // "function foo() {\n  return 1;\n}" = 31 chars. Use maxChars=35 to include it.
    const result = truncateAtLogicalBoundary(text, 35);
    expect(result).toBe("function foo() {\n  return 1;\n}");
  });

  it("falls back to newline truncation", () => {
    const text =
      "short line\nstill going\nand more";
    const result = truncateAtLogicalBoundary(text, 15);
    // No semicolons or braces, falls back to last newline boundary past halfway
    // "short line\n" = 11 chars, which is > 15 * 0.5 = 7.5, so it should cut there
    // The newline is preserved since it represents a logical line boundary
    expect(result).toBe("short line\n");
  });

  it("returns raw truncation when no good boundary is found", () => {
    const text = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
    const result = truncateAtLogicalBoundary(text, 20);
    expect(result).toBe("abcdefghijklmnopqrst"); // 20 chars, trimmed end
  });

  it("prefers boundaries past the halfway point", () => {
    const text =
      "aaaaaa;\nbbbbbb;\ncccccc;\ndddddd;\neeeeee;\nffffff;\ngggggg;";
    const result = truncateAtLogicalBoundary(text, 30);
    // Should cut at a boundary that's past 15 chars
    expect(result.length).toBeGreaterThan(15);
    expect(result.length).toBeLessThanOrEqual(31); // 30 + 1 for the boundary char
  });
});

// ===========================================================================
// processCompletionResponse (full pipeline integration)
// ===========================================================================

describe("processCompletionResponse", () => {
  it("extracts clean code from a markdown-wrapped response", () => {
    const input =
      "Here is the code:\n\n```javascript\nconsole.log('hello');\n```\n\nThis prints hello.";
    const result = processCompletionResponse(input);
    expect(result).toBe("console.log('hello');");
  });

  it("rejects purely conversational response (score too low)", () => {
    const input =
      "Here is a function that calculates the sum of two numbers. It takes two parameters and returns their sum.";
    const result = processCompletionResponse(input);
    expect(result).toBe("");
  });

  it("rejects empty response", () => {
    expect(processCompletionResponse("")).toBe("");
  });

  it("accepts clean code with high score", () => {
    const code =
      "function add(a: number, b: number): number {\n  return a + b;\n}";
    const result = processCompletionResponse(code);
    expect(result).toBe(code);
  });

  it("accepts code with conversational preamble but code-like content", () => {
    const input = "Here is the code:\n\nconst result = data.map(x => x * 2);";
    const result = processCompletionResponse(input);
    expect(result).toBe("const result = data.map(x => x * 2);");
  });

  it("truncates overly long responses at a logical boundary", () => {
    // Build a response that's longer than the default 256 chars
    const longCode =
      "function foo() {\n" +
      "  const a = 1;\n".repeat(20) +
      "  return a;\n" +
      "}";
    const result = processCompletionResponse(longCode);
    expect(result.length).toBeLessThan(longCode.length);
    expect(result.length).toBeGreaterThan(0);
  });

  it("applies custom minScore threshold", () => {
    const conversational =
      "Sure! Here is a function that calculates the sum.";
    // With a very low threshold, it should still return something
    const result = processCompletionResponse(conversational, 5);
    // The preamble is stripped but the remaining text may still pass
    expect(typeof result).toBe("string");
  });

  it("rejects with high minScore threshold", () => {
    const plausibleCode = "const x = 1;";
    // With a very high threshold, even valid code could be rejected
    const result = processCompletionResponse(plausibleCode, 200);
    expect(result).toBe("");
  });
});
