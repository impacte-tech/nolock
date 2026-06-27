// ---------------------------------------------------------------------------
// Unit tests for RLHF storage utilities (src/lib/rlhf.ts)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import {
  getModelContext,
  getModelConfigurations,
  readRlhfSettings,
  saveRlhfFeedback,
} from "../rlhf";
import { mockInvoke } from "../../test/tauri-mock";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setLocal(key: string, value: string) {
  localStorage.setItem(key, value);
}

function removeLocal(key: string) {
  localStorage.removeItem(key);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getModelContext", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns provider and model from localStorage", () => {
    setLocal("nolock.backend", "openrouter");
    setLocal("nolock.chatModel", "gpt-4");
    const ctx = getModelContext();
    expect(ctx.provider).toBe("openrouter");
    expect(ctx.model).toBe("gpt-4");
  });

  it("defaults provider to 'ollama' when not set", () => {
    setLocal("nolock.chatModel", "qwen3:8b");
    const ctx = getModelContext();
    expect(ctx.provider).toBe("ollama");
    expect(ctx.model).toBe("qwen3:8b");
  });

  it("returns empty model string when chatModel is not set", () => {
    setLocal("nolock.backend", "llamacpp");
    const ctx = getModelContext();
    expect(ctx.provider).toBe("llamacpp");
    expect(ctx.model).toBe("");
  });
});

describe("getModelConfigurations", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns defaults when no settings saved", () => {
    const cfg = getModelConfigurations();
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.max_tokens).toBe(2048);
    expect(cfg.system_prompt).toBe("");
  });

  it("reads temperature, max_tokens, and system_prompt", () => {
    setLocal("nolock.chatTemperature", "0.3");
    setLocal("nolock.chatMaxTokens", "4096");
    setLocal("nolock.chatSystemPrompt", "Be concise.");
    const cfg = getModelConfigurations();
    expect(cfg.temperature).toBe(0.3);
    expect(cfg.max_tokens).toBe(4096);
    expect(cfg.system_prompt).toBe("Be concise.");
  });
});

describe("readRlhfSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns default values when no RLHF settings saved", () => {
    const s = readRlhfSettings();
    expect(s.enabled).toBe(true);
    expect(s.root).toBe(".rlhf");
    expect(s.goodDir).toBe("good");
    expect(s.badDir).toBe("bad");
  });

  it("reads custom settings from localStorage", () => {
    setLocal("nolock.rlhf.enabled", "false");
    setLocal("nolock.rlhf.root", "_feedback");
    setLocal("nolock.rlhf.goodDir", "pos");
    setLocal("nolock.rlhf.badDir", "neg");
    const s = readRlhfSettings();
    expect(s.enabled).toBe(false);
    expect(s.root).toBe("_feedback");
    expect(s.goodDir).toBe("pos");
    expect(s.badDir).toBe("neg");
  });

  it("treats missing enabled key as enabled (true)", () => {
    const s = readRlhfSettings();
    expect(s.enabled).toBe(true);
  });

  it("treats any non-'false' string as enabled", () => {
    setLocal("nolock.rlhf.enabled", "yes");
    expect(readRlhfSettings().enabled).toBe(true);
    setLocal("nolock.rlhf.enabled", "1");
    expect(readRlhfSettings().enabled).toBe(true);
    setLocal("nolock.rlhf.enabled", "");
    expect(readRlhfSettings().enabled).toBe(true);
  });
});

describe("saveRlhfFeedback", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    // Default: make invoke succeed for create_file and write_file
    mockInvoke.mockResolvedValue(undefined);
  });

  // --- Good feedback ---

  it("saves thumbs-up feedback to good dir under project root", async () => {
    const path = await saveRlhfFeedback("/my/project", {
      feedback_type: "good",
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
      question: "What is Rust?",
      answer: "Rust is a systems language.",
      user_correction: "",
    });

    // Path should start with project root + default .rlhf/good/
    expect(path).toMatch(/^\/my\/project\/\.rlhf\/good\/\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{4}\.json$/);

    // Should have called create_file + write_file
    expect(mockInvoke).toHaveBeenCalledWith("create_file", { path: path });
    expect(mockInvoke).toHaveBeenCalledWith("write_file", { path: path, content: expect.any(String) });
  });

  it("saves thumbs-down feedback to bad dir", async () => {
    const path = await saveRlhfFeedback("/my/project", {
      feedback_type: "bad",
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
      question: "Explain monads.",
      answer: "Monads are...",
      user_correction: "Too complex, simplify.",
    });

    expect(path).toMatch(/^\/my\/project\/\.rlhf\/bad\/\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{4}\.json$/);
    expect(mockInvoke).toHaveBeenCalledWith("write_file", { path, content: expect.any(String) });
  });

  // --- RLHF disabled ---

  it("skips save and returns empty string when RLHF is disabled", async () => {
    setLocal("nolock.rlhf.enabled", "false");
    const path = await saveRlhfFeedback("/my/project", {
      feedback_type: "good",
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
      question: "Hi",
      answer: "Hello",
      user_correction: "",
    });
    expect(path).toBe("");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // --- Custom directory settings ---

  it("uses custom root/goodDir from settings", async () => {
    setLocal("nolock.rlhf.root", "_feedback");
    setLocal("nolock.rlhf.goodDir", "likes");

    const path = await saveRlhfFeedback("/custom/path", {
      feedback_type: "good",
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
      question: "Q",
      answer: "A",
      user_correction: "",
    });

    expect(path).toMatch(/^\/custom\/path\/_feedback\/likes\/\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{4}\.json$/);
  });

  it("uses custom badDir from settings", async () => {
    setLocal("nolock.rlhf.badDir", "dislikes");

    const path = await saveRlhfFeedback("/path", {
      feedback_type: "bad",
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
      question: "Q",
      answer: "A",
      user_correction: "Fix this",
    });

    expect(path).toMatch(/^\/path\/\.rlhf\/dislikes\/\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{4}\.json$/);
  });

  // --- Empty rootPath (fallback) ---

  it("uses get_rlhf_dir command when rootPath is empty", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_rlhf_dir") return Promise.resolve("/app/data/rlhf");
      return Promise.resolve(undefined);
    });

    const path = await saveRlhfFeedback("", {
      feedback_type: "good",
      model_provider: "ollama",
      model_name: "model",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
      question: "Q",
      answer: "A",
      user_correction: "",
    });

    expect(path).toMatch(/^\/app\/data\/rlhf\/good\/\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{4}\.json$/);
    // Should have called get_rlhf_dir
    expect(mockInvoke).toHaveBeenCalledWith("get_rlhf_dir");
  });

  it("falls back to /tmp/nolock/rlhf when get_rlhf_dir fails", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_rlhf_dir") return Promise.reject(new Error("no tauri"));
      return Promise.resolve(undefined);
    });

    const path = await saveRlhfFeedback("", {
      feedback_type: "good",
      model_provider: "ollama",
      model_name: "model",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
      question: "Q",
      answer: "A",
      user_correction: "",
    });

    expect(path).toMatch(/^\/tmp\/nolock\/rlhf\/good\/\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{4}\.json$/);
  });

  // --- Error handling ---

  it("throws when write_file fails", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "write_file") return Promise.reject(new Error("permission denied"));
      return Promise.resolve(undefined);
    });

    await expect(
      saveRlhfFeedback("/project", {
        feedback_type: "good",
        model_provider: "ollama",
        model_name: "m",
        model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
        timestamp: "2026-06-26T12:00:00.000Z",
        question: "Q",
        answer: "A",
        user_correction: "",
      }),
    ).rejects.toThrow(/Failed to save RLHF feedback/);
  });

  // --- JSON content ---

  it("writes valid JSON matching the RlhfData schema", async () => {
    let writtenContent = "";
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "write_file") {
        writtenContent = args?.content || "";
      }
      return Promise.resolve(undefined);
    });

    await saveRlhfFeedback("/p", {
      feedback_type: "bad",
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.5, max_tokens: 1024, system_prompt: "Be helpful" },
      timestamp: "2026-06-26T12:34:56.789Z",
      question: "How?",
      answer: "Like this.",
      user_correction: "Add more detail",
    });

    const parsed = JSON.parse(writtenContent);
    expect(parsed.feedback_type).toBe("bad");
    expect(parsed.model_provider).toBe("ollama");
    expect(parsed.model_name).toBe("qwen3:8b");
    expect(parsed.model_configurations.temperature).toBe(0.5);
    expect(parsed.model_configurations.max_tokens).toBe(1024);
    expect(parsed.model_configurations.system_prompt).toBe("Be helpful");
    expect(parsed.timestamp).toBe("2026-06-26T12:34:56.789Z");
    expect(parsed.question).toBe("How?");
    expect(parsed.answer).toBe("Like this.");
    expect(parsed.user_correction).toBe("Add more detail");
  });
});
