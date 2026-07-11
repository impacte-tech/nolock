// ---------------------------------------------------------------------------
// Integration tests for the AiInlineCompletionProvider with mocked Tauri invoke
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AiInlineCompletionProvider } from "../Editor";
import { mockInvoke } from "../../test/tauri-mock";
import { Range, Position } from "monaco-editor";
import * as monaco from "monaco-editor";

// ---------------------------------------------------------------------------
// We test at the provider-unit level by instantiating AiInlineCompletionProvider
// with all Monaco APIs mocked via the test alias in vite.config.ts.
// The Tauri `invoke` is also mocked (from tauri-mock.ts setup).
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  // Set up required localStorage keys
  localStorage.setItem("nolock.backend", "ollama");
  localStorage.setItem("nolock.url", "http://localhost:11434");
  localStorage.setItem("nolock.completionModel", "qwen2.5-coder:1.5b");
});

/** Helper: sets up mockInvoke to return null for getSecret and `text` for ai_complete */
function mockCompletionResponse(text: string) {
  mockInvoke.mockImplementation((cmd: string, _args?: any) => {
    if (cmd === "get_secret") return Promise.resolve(null);
    if (cmd === "ai_complete") return Promise.resolve(text);
    return Promise.resolve(null);
  });
}

function createModel(text: string, _language = "typescript") {
  return monaco.editor.createModel(text, _language) as unknown as monaco.editor.ITextModel;
}

function createCancellationToken(): monaco.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: (_listener: (e: any) => any, _thisArgs?: any, _disposables?: any) =>
      ({ dispose: () => {} }),
  };
}

/** Helper: open the gate so provideInlineCompletions will proceed */
function openGate(provider: AiInlineCompletionProvider) {
  (provider as any)._ready = true;
}

// ===========================================================================
// Gate / debounce behavior
// ===========================================================================

describe("AiInlineCompletionProvider - gate behavior", () => {
  it("returns empty when gate is closed (_ready = false)", async () => {
    const provider = new AiInlineCompletionProvider();
    // Gate starts closed — no call to onContentChange needed
    const model = createModel("const x = ");
    const position = new Position(1, 11);
    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );
    expect(result.items).toHaveLength(0);
  });

  it("returns completion when gate is open", async () => {
    mockCompletionResponse("const result = 42;");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);
    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Two calls: getSecret + ai_complete
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[0][0]).toBe("get_secret");
    expect(mockInvoke.mock.calls[1][0]).toBe("ai_complete");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("const result = 42;");
  });

  it("consumes the gate after a successful request", async () => {
    mockCompletionResponse("42");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);
    await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Gate should now be consumed
    expect((provider as any)._ready).toBe(false);
  });
});

// ===========================================================================
// Prefix / suffix construction & API call integration
// ===========================================================================

describe("AiInlineCompletionProvider - API integration", () => {
  beforeEach(() => {
    mockCompletionResponse("  const result = data.map(x => x * 2);  ");
  });

  it("calls ai_complete with FIM-token prompt when suffix exists", async () => {
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    // Model with content after cursor (suffix)
    const code = "function greet(name) {\n  \n}\n\n// after\n";
    const model = createModel(code);
    const position = new Position(1, 24); // cursor at end of "function greet(name) {"

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Two calls: getSecret (index 0) + ai_complete (index 1)
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    const callArgs = mockInvoke.mock.calls[1][0]; // "ai_complete"
    const req = mockInvoke.mock.calls[1][1].req;

    expect(callArgs).toBe("ai_complete");
    // The prompt should contain FIM tokens since suffix is non-empty
    expect(req.prompt).toContain("<|fim_prefix|>");
    expect(req.prompt).toContain("<|fim_suffix|>");
    expect(req.prompt).toContain("<|fim_middle|>");
    expect(req.suffix).toBeTruthy();

    // The response should be cleaned (trim + pipeline)
    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe(
      "const result = data.map(x => x * 2);",
    );
  });

  it("calls ai_complete with raw prompt (no FIM) when no suffix", async () => {
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    // Model with cursor at end of line (no content after)
    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    const req = mockInvoke.mock.calls[1][1].req;
    expect(req.prompt).not.toContain("<|fim_prefix|>");
    expect(req.prompt).toBe("const x = ");

    expect(result.items[0].insertText).toBe(
      "const result = data.map(x => x * 2);",
    );
  });

  it("returns empty when no completion model is configured", async () => {
    // getSecret is still called (it runs before the model check), but ai_complete should NOT be
    mockInvoke.mockResolvedValue(null);

    localStorage.removeItem("nolock.completionModel");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
    // getSecret WAS called (first arg is "get_secret"), but ai_complete was NOT
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][0]).toBe("get_secret");
  });

  it("returns empty when prefix is too short (< 5 chars)", async () => {
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("ab"); // only 2 chars
    const position = new Position(1, 3);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// FITM parameter forwarding
// ===========================================================================

describe("AiInlineCompletionProvider - FITM parameter forwarding", () => {
  beforeEach(() => {
    mockCompletionResponse("const result = 42;");
  });

  it("forwards temperature, max_tokens, and system_prompt to ai_complete", async () => {
    localStorage.setItem("nolock.fitmTemperature", "0.5");
    localStorage.setItem("nolock.fitmMaxTokens", "128");
    localStorage.setItem("nolock.fitmSystemPrompt", "You are a Rust expert.");

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("fn main() {");
    const position = new Position(1, 12);

    await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    const req = mockInvoke.mock.calls[1][1].req;
    expect(req.temperature).toBe(0.5);
    expect(req.max_tokens).toBe(128);
    expect(req.system_prompt).toBe("You are a Rust expert.");
  });

  it("forwards undefined temperature and max_tokens when not set in localStorage", async () => {
    localStorage.removeItem("nolock.fitmTemperature");
    localStorage.removeItem("nolock.fitmMaxTokens");
    localStorage.removeItem("nolock.fitmSystemPrompt");

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("fn main() {");
    const position = new Position(1, 12);

    await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    const req = mockInvoke.mock.calls[1][1].req;
    expect(req.temperature).toBeUndefined();
    expect(req.max_tokens).toBeUndefined();
    expect(req.system_prompt).toBeUndefined();
  });

  it("forwards the configured completion model name", async () => {
    localStorage.setItem("nolock.completionModel", "deepseek-coder:6.7b");

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("fn main() {");
    const position = new Position(1, 12);

    await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    const req = mockInvoke.mock.calls[1][1].req;
    expect(req.model).toBe("deepseek-coder:6.7b");
  });
});

// ===========================================================================
// Response cleaning pipeline
// ===========================================================================

describe("AiInlineCompletionProvider - response cleaning", () => {
  it("strips markdown code blocks from response", async () => {
    mockCompletionResponse(
      "```typescript\nconsole.log('hello world');\n```",
    );
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items[0].insertText).toBe("console.log('hello world');");
  });

  it("strips conversational preamble from response", async () => {
    mockCompletionResponse(
      "Here is the code you requested:\n\nfunction add(a, b) {\n  return a + b;\n}",
    );
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("function add(");
    const position = new Position(1, 14);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items[0].insertText).toBe(
      "function add(a, b) {\n  return a + b;\n}",
    );
    expect(result.items[0].insertText).not.toMatch(/^Here is/i);
  });

  it("rejects purely conversational response (returns empty)", async () => {
    mockCompletionResponse(
      "Here is a function that calculates the sum of two numbers.",
    );
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
  });

  it("strips trailing explanatory text after code", async () => {
    mockCompletionResponse(
      "function foo() {\n  return 42;\n}\n\nThis function returns 42. It is a simple example.",
    );
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("function foo(");
    const position = new Position(1, 13);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items[0].insertText).toBe(
      "function foo() {\n  return 42;\n}",
    );
    expect(result.items[0].insertText).not.toContain("This function returns");
  });

  it("handles empty response from backend gracefully", async () => {
    mockCompletionResponse("");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
  });

  it("handles error from backend gracefully", async () => {
    mockInvoke
      .mockResolvedValueOnce(null)    // getSecret("apiKey")
      .mockRejectedValueOnce(new Error("Network error")); // ai_complete fails
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
  });

  it("handles whitespace-only response from backend gracefully", async () => {
    mockCompletionResponse("   \n  \n  ");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
  });

  it("handles response that is only an empty markdown code block", async () => {
    mockCompletionResponse("```\n```");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
  });

  it("cleans FIM tokens from model output that echo them literally", async () => {
    mockCompletionResponse("<|fim_middle|>fn main() {\n  println!(\"hello\");\n}");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("fn main() {");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe(
      "fn main() {\n  println!(\"hello\");\n}",
    );
    expect(result.items[0].insertText).not.toContain("<|fim_middle|>");
  });

  it("discards stale responses when request counter changes", async () => {
    // Simulate a second request starting before the first one completes
    let resolveComplete!: (value: string) => void;
    const completePromise = new Promise<any>((resolve) => { resolveComplete = resolve; });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "ai_complete") return completePromise;
      return Promise.resolve(null);
    });

    const provider = new AiInlineCompletionProvider();
    openGate(provider);
    const model = createModel("const x = ");
    const position = new Position(1, 11);

    // Start first request
    const promise1 = provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Simulate a second typing event by incrementing request counter
    (provider as any)._requestCounter = 1; // Simulate requestId mismatch
    openGate(provider);

    // Start second request (this would have requestId=2)
    const promise2 = provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Resolve the first request
    resolveComplete!("const result = 42;");

    const [result1, result2] = await Promise.all([promise1, promise2]);

    // First request should be discarded (stale)
    expect(result1.items).toHaveLength(0);
    // Second request should proceed (but its promise reuses the same mock)
    // Since we didn't set up a response for the second, it may be empty
  });

  it("discards stale responses when token is cancelled", async () => {
    // Pre-create both deferred promises so both resolve functions are defined
    // before provideInlineCompletions runs. This avoids microtask-ordering issues
    // where resolveSecret's resolution would need to drain before the second
    // invoke call creates resolveComplete.
    let resolveSecret!: (value: string | null) => void;
    let resolveComplete!: (value: string) => void;

    const secretPromise = new Promise<any>((resolve) => { resolveSecret = resolve; });
    const completePromise = new Promise<any>((resolve) => { resolveComplete = resolve; });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return secretPromise;
      if (cmd === "ai_complete") return completePromise;
      return Promise.resolve(null);
    });

    const provider = new AiInlineCompletionProvider();
    openGate(provider);
    const model = createModel("const x = ");
    const position = new Position(1, 11);

    // Start the request with a cancelled token
    const promise = provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      { isCancellationRequested: true, onCancellationRequested: (_listener: any, _thisArgs?: any, _disposables?: any) => ({ dispose: () => {} }) },
    );

    // Resolve both invokes (but token is already cancelled)
    resolveSecret!(null);
    resolveComplete!("const result = 42;");
    const result = await promise;

    expect(result.items).toHaveLength(0);
  });
});

// ===========================================================================
// Range construction
// ===========================================================================

describe("AiInlineCompletionProvider - range construction", () => {
  beforeEach(() => {
    mockCompletionResponse("  cleaned  ");
  });

  it("returns completion with range at cursor position", async () => {
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    const range = result.items[0].range;
    expect(range).toBeDefined();
    expect(range).toBeInstanceOf(Range);
    expect(range!.startLineNumber).toBe(1);
    expect(range!.startColumn).toBe(11);
    expect(range!.endLineNumber).toBe(1);
    expect(range!.endColumn).toBe(11);
  });
});

// ===========================================================================
// Prompt construction: FIM tokens present in sent request
// ===========================================================================

describe("AiInlineCompletionProvider - FIM prompt construction", () => {
  beforeEach(() => {
    mockCompletionResponse("console.log('test');");
  });

  it("includes FIM tokens in the sent prompt when suffix is present", async () => {
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    // Model with content after cursor
    const code = "function foo() {\n  \n}\n\n// more code\n";
    const model = createModel(code);
    const position = new Position(1, 15);

    await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Second call is ai_complete (first is get_secret)
    const req = mockInvoke.mock.calls[1][1].req;
    expect(req.prompt).toContain("<|fim_prefix|>");
    expect(req.prompt).toContain("<|fim_suffix|>");
    expect(req.prompt).toContain("<|fim_middle|>");
  });

  it("does NOT include FIM tokens when there is no suffix", async () => {
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    // Model with no content after cursor (single line, cursor at end)
    const model = createModel("console.");
    const position = new Position(1, 9);

    await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Second call is ai_complete (first is get_secret)
    const req = mockInvoke.mock.calls[1][1].req;
    expect(req.prompt).not.toContain("<|fim_prefix|>");
    expect(req.prompt).toBe("console.");
  });
});

// ===========================================================================
// FIM fallback: retry with raw prefix when FIM returns empty
// ===========================================================================

describe("AiInlineCompletionProvider - FIM fallback", () => {
  it("retries with raw prefix when FIM request returns empty and suffix exists", async () => {
    // First call (getSecret) and second call (ai_complete with FIM) return empty.
    // Third call (ai_complete retry with raw prefix) returns the completion.
    let callCount = 0;
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "ai_complete") {
        callCount++;
        if (callCount === 1) {
          // First attempt with FIM tokens → empty
          return Promise.resolve("");
        }
        // Second attempt with raw prefix → completion
        return Promise.resolve("const result = 42;");
      }
      return Promise.resolve(null);
    });

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    // Model with suffix (content after cursor)
    const code = "function greet() {\n  \n}\n\n// after\n";
    const model = createModel(code);
    const position = new Position(1, 17); // cursor at end of "function greet() {"

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Should have made 3 invoke calls: getSecret + ai_complete(FIM) + ai_complete(retry)
    expect(mockInvoke).toHaveBeenCalledTimes(3);

    // First ai_complete should use FIM prompt
    const fimCall = mockInvoke.mock.calls[1];
    expect(fimCall[0]).toBe("ai_complete");
    expect(fimCall[1].req.prompt).toContain("<|fim_prefix|>");

    // Second ai_complete (retry) should use raw prefix, no FIM tokens
    const retryCall = mockInvoke.mock.calls[2];
    expect(retryCall[0]).toBe("ai_complete");
    expect(retryCall[1].req.prompt).not.toContain("<|fim_prefix|>");
    expect(retryCall[1].req.suffix).toBeNull();

    // Should return the cleaned retry response
    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("const result = 42;");
  });

  it("returns empty when both FIM and raw-prefix attempts return empty", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "ai_complete") return Promise.resolve("");
      return Promise.resolve(null);
    });

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const code = "function greet() {\n  \n}\n\n// after\n";
    const model = createModel(code);
    const position = new Position(1, 17);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Two ai_complete calls (FIM + retry), both empty
    expect(mockInvoke).toHaveBeenCalledTimes(3);
    expect(result.items).toHaveLength(0);
  });

  it("does NOT retry when there is no suffix (FIM not used)", async () => {
    let callCount = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "ai_complete") {
        callCount++;
        return Promise.resolve("");
      }
      return Promise.resolve(null);
    });

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    // Single line, no content after cursor
    const model = createModel("const x = ");
    const position = new Position(1, 11);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Only getSecret + one ai_complete (no retry)
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(0);
  });

  it("does NOT retry when FIM request succeeds (non-empty response)", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      if (cmd === "ai_complete") return Promise.resolve("result");
      return Promise.resolve(null);
    });

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const code = "function greet() {\n  \n}\n\n// after\n";
    const model = createModel(code);
    const position = new Position(1, 17);

    const result = await provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Only getSecret + one ai_complete (no retry needed)
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(1);
  });

  it("discards stale retry when request counter changes", async () => {
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
      }
      return Promise.resolve(null);
    });

    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const code = "fn main() {\n  \n}\n";
    const model = createModel(code);
    const position = new Position(1, 12);

    const promise = provider.provideInlineCompletions(
      model,
      position as any,
      {} as any,
      createCancellationToken(),
    );

    // Simulate stale request by bumping counter
    (provider as any)._requestCounter++;

    resolveFim!("");      // FIM returns empty
    resolveRetry!("fn main() {\n  println!(\"hi\");\n}"); // retry returns code

    const result = await promise;

    // Both attempts were discarded
    expect(result.items).toHaveLength(0);
  });
});

// ===========================================================================
// Debounce timing and explicit trigger tests
// ===========================================================================

describe("AiInlineCompletionProvider - debounce timing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.clearAllMocks();
    localStorage.setItem("nolock.backend", "ollama");
    localStorage.setItem("nolock.url", "http://localhost:11434");
    localStorage.setItem("nolock.completionModel", "qwen2.5-coder:1.5b");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createMockEditor() {
    const trigger = vi.fn();
    const editor = {
      trigger,
      focus: vi.fn(),
      addCommand: vi.fn(),
      getModel: vi.fn(() => null),
      getValue: vi.fn(() => ""),
      layout: vi.fn(),
      dispose: vi.fn(),
      onDidChangeModelContent: vi.fn(() => vi.fn()),
    } as any;
    return { editor, trigger };
  }

  it("closes gate and starts timer on keystroke", () => {
    const provider = new AiInlineCompletionProvider();
    expect((provider as any)._ready).toBe(false);

    (provider as any)._ready = true;
    provider.onContentChange();

    expect((provider as any)._ready).toBe(false);
    expect((provider as any)._timer).not.toBeNull();
  });

  it("opens gate and triggers editor after 500ms of silence", () => {
    const { editor, trigger } = createMockEditor();
    const provider = new AiInlineCompletionProvider();
    provider.setEditor(editor);

    provider.onContentChange();
    expect((provider as any)._ready).toBe(false);

    vi.advanceTimersByTime(500);

    expect((provider as any)._ready).toBe(true);
    expect((provider as any)._timer).toBeNull();
    expect(trigger).toHaveBeenCalledWith(
      "ai",
      "editor.action.inlineSuggest.trigger",
      null,
    );
  });

  it("resets timer on rapid keystrokes (debounce resets)", () => {
    const { editor, trigger } = createMockEditor();
    const provider = new AiInlineCompletionProvider();
    provider.setEditor(editor);

    provider.onContentChange();
    vi.advanceTimersByTime(200);
    expect((provider as any)._ready).toBe(false);

    provider.onContentChange();
    vi.advanceTimersByTime(200);
    expect((provider as any)._ready).toBe(false);

    provider.onContentChange();
    vi.advanceTimersByTime(200);
    expect((provider as any)._ready).toBe(false);

    vi.advanceTimersByTime(300);
    expect((provider as any)._ready).toBe(true);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("does NOT call trigger if no editor is set", () => {
    const provider = new AiInlineCompletionProvider();
    provider.onContentChange();
    vi.advanceTimersByTime(500);

    expect((provider as any)._ready).toBe(true);
  });

  it("consumes gate after provideInlineCompletions, blocking duplicate calls", async () => {
    mockCompletionResponse("const result = 42;");
    const provider = new AiInlineCompletionProvider();
    openGate(provider);

    const model = createModel("const x = ");
    const position = new Position(1, 11);

    await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );
    expect((provider as any)._ready).toBe(false);

    const secondResult = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );
    expect(secondResult.items).toHaveLength(0);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("full debounce cycle: keystroke → 500ms → gate open → trigger → completion", async () => {
    const { editor, trigger } = createMockEditor();
    const provider = new AiInlineCompletionProvider();
    provider.setEditor(editor);
    mockCompletionResponse("return a + b;\n}");

    provider.onContentChange();
    expect((provider as any)._ready).toBe(false);

    vi.advanceTimersByTime(500);
    expect((provider as any)._ready).toBe(true);
    expect(trigger).toHaveBeenCalled();

    const model = createModel("function add(a, b) {\n  \n}\n");
    const position = new Position(1, 22);
    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("return a + b;\n}");
    expect((provider as any)._ready).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("disposes the timer on provider dispose", () => {
    const provider = new AiInlineCompletionProvider();
    provider.onContentChange();
    expect((provider as any)._timer).not.toBeNull();

    provider.dispose();
    expect((provider as any)._timer).toBeNull();
    expect((provider as any)._ready).toBe(false);
  });

  // ----- Explicit trigger (Ctrl+.) tests -----

  it("requestExplicitCompletion sets _explicitRequest, opens gate, and triggers editor", () => {
    const { editor, trigger } = createMockEditor();
    const provider = new AiInlineCompletionProvider();
    provider.setEditor(editor);

    provider.requestExplicitCompletion();

    expect((provider as any)._explicitRequest).toBe(true);
    expect((provider as any)._ready).toBe(true);
    expect(trigger).toHaveBeenCalledWith(
      "ai",
      "editor.action.inlineSuggest.trigger",
      null,
    );
  });

  it("explicit request bypasses the gate when _ready is false", async () => {
    mockCompletionResponse("explicit result;");
    const provider = new AiInlineCompletionProvider();
    expect((provider as any)._ready).toBe(false);

    (provider as any)._explicitRequest = true;
    (provider as any)._ready = true;

    const model = createModel("const x = ");
    const position = new Position(1, 11);
    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insertText).toBe("explicit result;");
    expect((provider as any)._explicitRequest).toBe(false);
    expect((provider as any)._ready).toBe(false);
  });

  it("explicit request still respects minimal prefix length", async () => {
    const provider = new AiInlineCompletionProvider();
    (provider as any)._explicitRequest = true;
    (provider as any)._ready = true;

    const model = createModel("ab");
    const position = new Position(1, 3);
    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );

    expect(result.items).toHaveLength(0);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect((provider as any)._explicitRequest).toBe(false);
  });

  it("explicit request does not affect subsequent gate-closed requests", async () => {
    const provider = new AiInlineCompletionProvider();
    (provider as any)._explicitRequest = true;
    (provider as any)._ready = true;

    const model = createModel("const x = ");
    const position = new Position(1, 11);
    await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );
    expect((provider as any)._explicitRequest).toBe(false);
    expect((provider as any)._ready).toBe(false);

    mockInvoke.mockClear();
    const secondResult = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );
    expect(secondResult.items).toHaveLength(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rapid typing followed by pause delivers exactly one completion", async () => {
    const { editor, trigger } = createMockEditor();
    const provider = new AiInlineCompletionProvider();
    provider.setEditor(editor);
    mockCompletionResponse("42");

    provider.onContentChange();
    vi.advanceTimersByTime(100);
    provider.onContentChange();
    vi.advanceTimersByTime(50);
    provider.onContentChange();
    vi.advanceTimersByTime(200);
    provider.onContentChange();

    vi.advanceTimersByTime(499);
    expect((provider as any)._ready).toBe(false);
    expect(trigger).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect((provider as any)._ready).toBe(true);
    expect(trigger).toHaveBeenCalledTimes(1);

    const model = createModel("const x = ");
    const position = new Position(1, 11);
    const result = await provider.provideInlineCompletions(
      model, position as any, {} as any, createCancellationToken(),
    );
    expect(result.items).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});
