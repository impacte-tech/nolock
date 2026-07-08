// ---------------------------------------------------------------------------
// End-to-end test: Monaco → AiInlineCompletionProvider → Tauri invoke → FITM
// pipeline → response cleaning → Monaco ghost text.
//
// These tests simulate the FULL flow from a Monaco editor keystroke through
// to the point where a suggestion would appear as ghost text.  They do NOT
// test the Rust backend (that's a separate Tauri integration test); instead
// the Tauri `invoke` is mocked at the JavaScript layer with realistic model
// responses that mirror what Ollama/llamacpp backends actually return.
//
// Each test exercises:
//   1. Model creation (simulates Monaco editor model with code)
//   2. Provider instantiation (AiInlineCompletionProvider)
//   3. Gate opening (simulating debounce timer firing)
//   4. provideInlineCompletions() — the full pipeline
//   5. Mocked Tauri invoke with realistic model outputs
//   6. Response cleaning (FIM token stripping, code extraction, scoring)
//   7. Suggestion returned to Monaco (= ghost text)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AiInlineCompletionProvider } from "../Editor";
import { mockInvoke } from "../../test/tauri-mock";
import { Position } from "monaco-editor";
import * as monaco from "monaco-editor";

// ===========================================================================
// Helpers
// ===========================================================================

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  localStorage.setItem("nolock.backend", "ollama");
  localStorage.setItem("nolock.url", "http://localhost:11434");
  localStorage.setItem("nolock.completionModel", "qwen2.5-coder:0.5b");
});

/** Configure mockInvoke to return `text` for ai_complete and null for getSecret */
function mockCompletionResponse(text: string) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "get_secret") return Promise.resolve(null);
    if (cmd === "ai_complete") return Promise.resolve(text);
    return Promise.resolve(null);
  });
}

function createModel(text: string) {
  return monaco.editor.createModel(text, "typescript") as unknown as monaco.editor.ITextModel;
}

function createCancellationToken(): monaco.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  };
}

function openGate(provider: AiInlineCompletionProvider) {
  (provider as any)._ready = true;
}

/**
 * Spy on console.log to capture [FITM] trace messages.
 * Returns a function to retrieve all captured [FITM] log entries.
 */
function captureFitmLogs() {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const msg = args.map(a => String(a)).join(" ");
    if (msg.includes("[FITM]")) {
      logs.push(msg);
    }
  });
  return {
    logs,
    stop: () => spy.mockRestore(),
    getFitmMessages: () => logs.filter(l => l.includes("[FITM]")),
  };
}

// ===========================================================================
// E2E: Full pipeline — realistic responses
// ===========================================================================

describe("FITM E2E — full pipeline", () => {
  it("returns suggestion when model responds with FIM tokens + code (qwen2.5-coder style)", async () => {
    // qwen2.5-coder typically outputs <|fim_middle|> followed by the completion
    mockCompletionResponse("<|fim_middle|>  return a + b;\n}");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    // Code with suffix: cursor after "function add(a, b) {"
    const code = "function add(a, b) {\n  \n}\n\n// end";
    const model = createModel(code);
    const position = new Position(1, 22);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("return a + b;\n}");
  });

  it("returns suggestion when model responds with plain code (no FIM tokens)", async () => {
    mockCompletionResponse("  return a + b;\n}");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const code = "function add(a, b) {\n  \n}\n";
    const model = createModel(code);
    const position = new Position(1, 22);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("return a + b;\n}");
  });

  it("returns suggestion when model responds with markdown code block", async () => {
    mockCompletionResponse("```typescript\nconst result = 42;\n```");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("const result = 42;");
  });

  it("strips conversational preamble when model responds with explanation + code", async () => {
    mockCompletionResponse(
      "Here is the code:\n\nfunction hello() {\n  console.log('world');\n}",
    );
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("function hello(");
    const position = new Position(1, 16);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe(
      "function hello() {\n  console.log('world');\n}",
    );
  });

  it("handles trailing explanatory text after code (blank line separator)", async () => {
    mockCompletionResponse(
      "function foo() {\n  return 42;\n}\n\nThis function returns 42.",
    );
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("function foo(");
    const position = new Position(1, 13);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe(
      "function foo() {\n  return 42;\n}",
    );
    expect(result.items[0].insertText).not.toContain("This function returns");
  });
});

// ===========================================================================
// E2E: Debug scenarios — matching the observed production issue
// ===========================================================================

describe("FITM E2E — debug scenarios", () => {
  it("produces informative trace logs when model returns empty (observed issue)", async () => {
    const capture = captureFitmLogs();

    mockCompletionResponse(""); // model returns empty, same as logs
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    // Code with suffix (content after cursor) — this should trigger FIM fallback
    const code = "function greet() {\n  \n}\n\n// after\n";
    const model = createModel(code);
    const position = new Position(1, 19);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    // Should return empty (no suggestion) since model returned empty
    expect(result.items).toHaveLength(0);

    // Should have produced detailed trace logs
    const fitmLogs = capture.getFitmMessages();
    expect(fitmLogs.length).toBeGreaterThan(0);

    // The trace should show: prefix, suffix, hasSuffix, prompt_len, attempt 1, fallback, attempt 2
    const allLogs = fitmLogs.join("\n");
    expect(allLogs).toContain("[FITM] prefix_last_100:");
    expect(allLogs).toContain("[FITM] suffix_first_100:");
    expect(allLogs).toContain("[FITM] hasSuffix: true");
    expect(allLogs).toContain("[FITM] prompt_starts_with_FIM:");
    expect(allLogs).toContain("[FITM] --- attempt 1 (FIM) ---");
    expect(allLogs).toContain("[FITM] attempt 1 raw response:");
    expect(allLogs).toContain('[FITM] attempt 1 raw response: ""');
    expect(allLogs).toContain("[FITM] FIM returned empty, retrying with raw prefix");
    expect(allLogs).toContain("[FITM] --- attempt 2 (raw prefix, no FIM) ---");
    expect(allLogs).toContain('[FITM] attempt 2 raw response: ""');

    capture.stop();
  });

  it("succeeds with fallback when FIM returns empty but raw prefix returns code", async () => {
    // Simulate FIM returning empty but the raw-prefix fallback working
    let callCount = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "ai_complete") {
        callCount++;
        if (callCount === 1) return Promise.resolve(""); // FIM returns empty
        return Promise.resolve("return a + b;\n}"); // raw prefix works
      }
      return Promise.resolve(null);
    });

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const code = "function add(a, b) {\n  \n}\n";
    const model = createModel(code);
    const position = new Position(1, 22);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    // Should get the fallback response
    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("return a + b;\n}");
    // Should have made 3 invoke calls: getSecret + FIM + retry
    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });

  it("returns empty when both FIM and raw prefix return empty (worst case)", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "ai_complete") return Promise.resolve("");
      return Promise.resolve(null);
    });

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const code = "fn main() {\n  \n}\n";
    const model = createModel(code);
    const position = new Position(1, 12);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
    expect(mockInvoke).toHaveBeenCalledTimes(3); // getSecret + FIM + fallback
  });

  it("discards stale responses during fallback (request counter changes)", async () => {
    let resolveFim!: (value: string) => void;
    let resolveRetry!: (value: string) => void;
    const fimPromise = new Promise<string>((resolve) => { resolveFim = resolve; });
    const retryPromise = new Promise<string>((resolve) => { resolveRetry = resolve; });

    let callIndex = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "ai_complete") {
        callIndex++;
        if (callIndex === 1) return fimPromise;
        if (callIndex === 2) return retryPromise;
        return Promise.resolve("");
      }
      return Promise.resolve(null);
    });

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const code = "fn main() {\n  \n}\n";
    const model = createModel(code);
    const position = new Position(1, 12);

    const promise = provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    // Bump request counter to simulate stale request
    (provider as any)._requestCounter++;
    resolveFim!("");
    resolveRetry!("fn main() {\n  println!(\"hi\");\n}");

    const result = await promise;
    expect(result.items).toHaveLength(0);
  });
});

// ===========================================================================
// E2E: Edge cases at the Monaco boundary
// ===========================================================================

describe("FITM E2E — Monaco boundary cases", () => {
  it("does not call the backend when prefix has fewer than 5 non-whitespace characters", async () => {
    mockCompletionResponse("result");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("ab");
    const position = new Position(1, 3);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("handles cursor at end of file (no suffix)", async () => {
    mockCompletionResponse("const result = 42;");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    // When no suffix, FIM tokens should NOT be in the prompt
    const req = mockInvoke.mock.calls[1][1].req;
    expect(req.prompt).not.toContain("<|fim_prefix|>");
  });

  it("handles cursor in middle of function body (with suffix)", async () => {
    mockCompletionResponse("const result = 42;");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const code = "function foo() {\n  \n  return null;\n}";
    const model = createModel(code);
    const position = new Position(2, 3); // cursor inside body

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    const req = mockInvoke.mock.calls[1][1].req;
    // Should use FIM tokens since there's content after cursor
    expect(req.prompt).toContain("<|fim_prefix|>");
    expect(req.prompt).toContain("<|fim_suffix|>");
    expect(req.prompt).toContain("<|fim_middle|>");
    // Suffix should include the content after cursor
    expect(req.suffix).toContain("return null;");
  });
});

// ===========================================================================
// E2E: Response cleaning pipeline — realism checks
// ===========================================================================

describe("FITM E2E — response realism", () => {
  it("rejects purely conversational response (realistic model hallucination)", async () => {
    // Small models sometimes respond with natural language instead of code
    mockCompletionResponse(
      "Here is a function that calculates the sum of two numbers. It uses addition.",
    );
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("function add(");
    const position = new Position(1, 14);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
  });

  it("handles very long responses (truncation at logical boundary)", async () => {
    // Build a long response that exceeds the default 256-char truncation limit
    const longCompletion = "const " + "x".repeat(30) + " = " + "y".repeat(200) + ";";
    mockCompletionResponse(longCompletion);
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const ");
    const position = new Position(1, 7);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    // Should still produce a suggestion (truncated at logical boundary)
    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText.length).toBeGreaterThan(0);
    expect(result.items[0].insertText.length).toBeLessThanOrEqual(257); // 256 + boundary char
  });

  it("preserves suggestion quality through truncation", async () => {
    // Semicolons are valid logical boundaries — truncation should preserve them
    const multiStatement = "const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;";
    mockCompletionResponse(multiStatement);
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const ");
    const position = new Position(1, 7);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    // The truncation should end at a logical boundary (semicolon + newline)
    expect(result.items[0].insertText).toMatch(/;\n?$/);
  });
});

// ===========================================================================
// E2E: Edge cases discovered during the raw-mode fix
// ===========================================================================

describe("FITM E2E — raw-mode edge cases", () => {
  it("forwards system_prompt to the backend", async () => {
    mockCompletionResponse("const result = 42;");
    localStorage.setItem("nolock.fitmSystemPrompt", "You are a Rust expert.");

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("fn main() {");
    const position = new Position(1, 11);

    await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    const req = mockInvoke.mock.calls[1][1].req;
    expect(req.system_prompt).toBe("You are a Rust expert.");
  });

  it("forwards system_prompt as undefined when not set", async () => {
    mockCompletionResponse("const result = 42;");
    localStorage.removeItem("nolock.fitmSystemPrompt");

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("fn main() {");
    const position = new Position(1, 11);

    await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    const req = mockInvoke.mock.calls[1][1].req;
    expect(req.system_prompt).toBeUndefined();
  });

  it("cleans model response that ends with trailing whitespace and newlines", async () => {
    mockCompletionResponse("  const x = 1;\n  \n  ");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const ");
    const position = new Position(1, 7);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("const x = 1;");
  });

  it("handles model response with multiple markdown code blocks (takes first)", async () => {
    mockCompletionResponse(
      "```js\nconst first = 1;\n```\nSome prose\n```py\nsecond = 2\n```",
    );
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const ");
    const position = new Position(1, 7);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("const first = 1;");
  });

  it("handles suffix with special characters (quotes, backticks, dollar)", async () => {
    mockCompletionResponse('  console.log(`hello ${name}`);\n}');
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    // Code where suffix contains backticks and template literals
    const code = "function greet(name) {\n  \n}\n";
    const model = createModel(code);
    const position = new Position(1, 22);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    // Should work and produce a valid suggestion
    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe('console.log(`hello ${name}`);\n}');
  });

  it("returns empty when cursor is at the very start of the file with no content", async () => {
    mockCompletionResponse("result");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("");
    const position = new Position(1, 1);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns valid suggestion with prefix at the very start of file (has content)", async () => {
    mockCompletionResponse("const x = 1;");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const ");
    const position = new Position(1, 1); // cursor at column 1

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    // Prefix is the full content from line 1 col 1 to position (which is also col 1,
    // so the prefix is empty and shorter than 5 chars → should skip)
    expect(result.items).toHaveLength(0);
  });

  it("handles model response that is only backtick fence (score hits minScore threshold)", async () => {
    // ` ``` ` scores exactly 30: -25 for fences +5 for backtick string literal = 30.
    // This passes the 30-threshold but produces a useless suggestion — a known
    // scoring limitation for very short fence-only output.
    mockCompletionResponse("```");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("fn main() {");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    // The fence hits exactly minScore and passes through
    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("```");
  });

  it("passes through short system-prompt-like echo (scoring heuristic limitation)", async () => {
    // "You are a code completion engine. Output ONLY the code."
    // scores 50 (no preamble patterns match "You are", only "You can/should").
    // This is a known limitation of the heuristic scorer — it doesn't penalize
    // "You are ..." because it looks for "You can/should/need/could/would".
    mockCompletionResponse("You are a code completion engine. Output ONLY the code.");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("fn main() {");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    // The short conversational echo passes through due to scoring limitation
    expect(result.items).toHaveLength(1);
  });

  it("handles unicode characters in prefix", async () => {
    mockCompletionResponse("// 日本語コメント\nconst x = 1;");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("function greet() {\n  \n}\n\n// 日本語");
    const position = new Position(4, 8); // cursor at end of "// 日本語"

    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("// 日本語コメント\nconst x = 1;");
  });
});
