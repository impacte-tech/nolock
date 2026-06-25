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
