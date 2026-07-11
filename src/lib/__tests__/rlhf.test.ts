// ---------------------------------------------------------------------------
// Unit tests for RLHF storage utilities (src/lib/rlhf.ts)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import {
  getModelContext,
  getModelConfigurations,
  readRlhfSettings,
  saveKtoFeedback,
  saveDpoFeedback,
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
    expect(s.dpoDir).toBe("dpo");
    expect(s.goodDir).toBe("good");
    expect(s.badDir).toBe("bad");
    expect(s.pairwiseDir).toBe("pairwise");
    expect(s.dpoEnabled).toBe(false);
    expect(s.dpoInterval).toBe(10);
  });

  it("reads custom KTO settings from localStorage", () => {
    setLocal("nolock.rlhf.enabled", "false");
    setLocal("nolock.rlhf.root", "_feedback");
    setLocal("nolock.rlhf.goodDir", "pos");
    setLocal("nolock.rlhf.badDir", "neg");
    const s = readRlhfSettings();
    expect(s.enabled).toBe(false);
    expect(s.root).toBe("_feedback");
    expect(s.dpoDir).toBe("dpo");
    expect(s.goodDir).toBe("pos");
    expect(s.badDir).toBe("neg");
    expect(s.pairwiseDir).toBe("pairwise");
  });

  it("reads custom DPO settings from localStorage", () => {
    setLocal("nolock.rlhf.dpoEnabled", "true");
    setLocal("nolock.rlhf.dpoInterval", "5");
    const s = readRlhfSettings();
    expect(s.dpoEnabled).toBe(true);
    expect(s.dpoInterval).toBe(5);
    expect(s.dpoDir).toBe("dpo");
    expect(s.pairwiseDir).toBe("pairwise");
  });

  it("reads custom dpoDir and pairwiseDir from localStorage", () => {
    setLocal("nolock.rlhf.dpoDir", "rlhf_data");
    setLocal("nolock.rlhf.pairwiseDir", "preferences");
    const s = readRlhfSettings();
    expect(s.dpoDir).toBe("rlhf_data");
    expect(s.pairwiseDir).toBe("preferences");
  });

  it("defaults dpoDir to 'dpo' when not set", () => {
    // Don't set dpoDir
    const s = readRlhfSettings();
    expect(s.dpoDir).toBe("dpo");
  });

  it("defaults pairwiseDir to 'pairwise' when not set", () => {
    // Don't set pairwiseDir
    const s = readRlhfSettings();
    expect(s.pairwiseDir).toBe("pairwise");
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

  it("defaults dpoInterval to 10 when not set", () => {
    setLocal("nolock.rlhf.dpoEnabled", "true");
    // Don't set dpoInterval
    const s = readRlhfSettings();
    expect(s.dpoInterval).toBe(10);
  });

  it("defaults dpoEnabled to false when not set", () => {
    // Don't set dpoEnabled
    const s = readRlhfSettings();
    expect(s.dpoEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveKtoFeedback
// ---------------------------------------------------------------------------

describe("saveKtoFeedback", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
  });

  it("saves good (thumbs-up) feedback to good dir under project root", async () => {
    const path = await saveKtoFeedback("/my/project", {
      prompt: "What is Rust?",
      completion: "Rust is a systems language.",
      label: true,
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });

    expect(path).toBe("/my/project/.rlhf/dpo/good/ollama_qwen3_8b/data.jsonl");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("append_to_file", {
      path: "/my/project/.rlhf/dpo/good/ollama_qwen3_8b/data.jsonl",
      content: expect.any(String),
    });
  });

  it("saves bad (thumbs-down) feedback to bad dir", async () => {
    const path = await saveKtoFeedback("/my/project", {
      prompt: "Explain monads.",
      completion: "Monads are...",
      label: false,
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
      user_correction: "Too complex, simplify.",
    });

    expect(path).toBe("/my/project/.rlhf/dpo/bad/ollama_qwen3_8b/data.jsonl");
    expect(mockInvoke).toHaveBeenCalledWith("append_to_file", {
      path: "/my/project/.rlhf/dpo/bad/ollama_qwen3_8b/data.jsonl",
      content: expect.any(String),
    });
  });

  it("uses custom root/goodDir from settings", async () => {
    setLocal("nolock.rlhf.root", "_feedback");
    setLocal("nolock.rlhf.goodDir", "likes");

    const path = await saveKtoFeedback("/custom/path", {
      prompt: "Q",
      completion: "A",
      label: true,
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });

    expect(path).toBe("/custom/path/_feedback/dpo/likes/ollama_qwen3_8b/data.jsonl");
  });

  it("uses custom badDir from settings", async () => {
    setLocal("nolock.rlhf.badDir", "dislikes");

    const path = await saveKtoFeedback("/path", {
      prompt: "Q",
      completion: "A",
      label: false,
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
      user_correction: "Fix this",
    });

    expect(path).toBe("/path/.rlhf/dpo/dislikes/ollama_qwen3_8b/data.jsonl");
  });

  it("sanitises model key (non-alphanumeric chars replaced with underscore)", async () => {
    const path = await saveKtoFeedback("/p", {
      prompt: "Q",
      completion: "A",
      label: true,
      model_provider: "open-ai",
      model_name: "gpt-4o:latest",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });

    // The provider "open-ai" has a hyphen which is kept, model "gpt-4o:latest" has colon replaced
    expect(path).toBe("/p/.rlhf/dpo/good/open-ai_gpt-4o_latest/data.jsonl");
  });

  it("returns empty string and skips save when RLHF is disabled", async () => {
    setLocal("nolock.rlhf.enabled", "false");
    const path = await saveKtoFeedback("/my/project", {
      prompt: "Hi",
      completion: "Hello",
      label: true,
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });
    expect(path).toBe("");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("uses get_rlhf_dir command when rootPath is empty", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_rlhf_dir") return Promise.resolve("/app/data/rlhf");
      if (cmd === "append_to_file") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const path = await saveKtoFeedback("", {
      prompt: "Q",
      completion: "A",
      label: true,
      model_provider: "ollama",
      model_name: "model",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });

    expect(path).toBe("/app/data/rlhf/dpo/good/ollama_model/data.jsonl");
    expect(mockInvoke).toHaveBeenCalledWith("get_rlhf_dir");
    expect(mockInvoke).toHaveBeenCalledWith("append_to_file", {
      path: "/app/data/rlhf/dpo/good/ollama_model/data.jsonl",
      content: expect.any(String),
    });
  });

  it("falls back to /tmp/nolock/rlhf when get_rlhf_dir fails", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_rlhf_dir") return Promise.reject(new Error("no tauri"));
      if (cmd === "create_file") return Promise.resolve(undefined);
      if (cmd === "append_to_file") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const path = await saveKtoFeedback("", {
      prompt: "Q",
      completion: "A",
      label: true,
      model_provider: "ollama",
      model_name: "model",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });

    expect(path).toBe("/tmp/nolock/rlhf/dpo/good/ollama_model/data.jsonl");
  });

  it("throws when append_to_file fails", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "append_to_file") return Promise.reject(new Error("permission denied"));
      return Promise.resolve(undefined);
    });

    await expect(
      saveKtoFeedback("/project", {
        prompt: "Q",
        completion: "A",
        label: true,
        model_provider: "ollama",
        model_name: "m",
        model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
        timestamp: "2026-06-26T12:00:00.000Z",
      }),
    ).rejects.toThrow(/Failed to save KTO feedback/);
  });

  it("writes valid JSONL line matching the KtoEntry schema", async () => {
    let writtenContent = "";
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "append_to_file") {
        writtenContent = args?.content || "";
      }
      return Promise.resolve(undefined);
    });

    await saveKtoFeedback("/p", {
      prompt: "How?",
      completion: "Like this.",
      label: false,
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.5, max_tokens: 1024, system_prompt: "Be helpful" },
      timestamp: "2026-06-26T12:34:56.789Z",
      user_correction: "Add more detail",
    });

    // Should be a single JSON line (no pretty-print)
    expect(writtenContent.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.prompt).toBe("How?");
    expect(parsed.completion).toBe("Like this.");
    expect(parsed.label).toBe(false);
    expect(parsed.model_provider).toBe("ollama");
    expect(parsed.model_name).toBe("qwen3:8b");
    expect(parsed.model_configurations.temperature).toBe(0.5);
    expect(parsed.model_configurations.max_tokens).toBe(1024);
    expect(parsed.model_configurations.system_prompt).toBe("Be helpful");
    expect(parsed.timestamp).toBe("2026-06-26T12:34:56.789Z");
    expect(parsed.user_correction).toBe("Add more detail");
  });

  it("writes JSONL without user_correction when not provided", async () => {
    let writtenContent = "";
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "append_to_file") {
        writtenContent = args?.content || "";
      }
      return Promise.resolve(undefined);
    });

    await saveKtoFeedback("/p", {
      prompt: "Q",
      completion: "A",
      label: true,
      model_provider: "ollama",
      model_name: "m",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });

    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.user_correction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// saveDpoFeedback
// ---------------------------------------------------------------------------

describe("saveDpoFeedback", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
  });

  it("saves DPO feedback to dpo dir under project root", async () => {
    setLocal("nolock.rlhf.dpoEnabled", "true");
    const path = await saveDpoFeedback("/my/project", {
      prompt: "What is Rust?",
      chosen: "Rust is a systems language.",
      rejected: "Rust is a programming language.",
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });

    expect(path).toBe("/my/project/.rlhf/dpo/pairwise/ollama_qwen3_8b/data.jsonl");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("append_to_file", {
      path: "/my/project/.rlhf/dpo/pairwise/ollama_qwen3_8b/data.jsonl",
      content: expect.any(String),
    });
  });

  it("sanitises model key for DPO path", async () => {
    setLocal("nolock.rlhf.dpoEnabled", "true");
    const path = await saveDpoFeedback("/p", {
      prompt: "Q",
      chosen: "A",
      rejected: "B",
      model_provider: "open-router",
      model_name: "gpt-4o-mini",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });

    expect(path).toBe("/p/.rlhf/dpo/pairwise/open-router_gpt-4o-mini/data.jsonl");
  });

  it("returns empty string and skips save when RLHF is disabled", async () => {
    setLocal("nolock.rlhf.enabled", "false");
    const path = await saveDpoFeedback("/my/project", {
      prompt: "Q",
      chosen: "A",
      rejected: "B",
      model_provider: "ollama",
      model_name: "m",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });
    expect(path).toBe("");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns empty string and skips save when DPO is disabled", async () => {
    // RLHF enabled but DPO disabled (default)
    const path = await saveDpoFeedback("/my/project", {
      prompt: "Q",
      chosen: "A",
      rejected: "B",
      model_provider: "ollama",
      model_name: "m",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });
    expect(path).toBe("");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("saves when both RLHF and DPO are enabled", async () => {
    setLocal("nolock.rlhf.dpoEnabled", "true");

    const path = await saveDpoFeedback("/project", {
      prompt: "Q",
      chosen: "A",
      rejected: "B",
      model_provider: "ollama",
      model_name: "m",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });

    expect(path).toBe("/project/.rlhf/dpo/pairwise/ollama_m/data.jsonl");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("append_to_file", expect.any(Object));
  });

  it("uses get_rlhf_dir when rootPath is empty", async () => {
    setLocal("nolock.rlhf.dpoEnabled", "true");

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_rlhf_dir") return Promise.resolve("/fallback/rlhf");
      if (cmd === "append_to_file") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const path = await saveDpoFeedback("", {
      prompt: "Q",
      chosen: "A",
      rejected: "B",
      model_provider: "ollama",
      model_name: "m",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });

    expect(path).toBe("/fallback/rlhf/dpo/pairwise/ollama_m/data.jsonl");
    expect(mockInvoke).toHaveBeenCalledWith("get_rlhf_dir");
  });

  it("throws when append_to_file fails", async () => {
    setLocal("nolock.rlhf.dpoEnabled", "true");

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "append_to_file") return Promise.reject(new Error("disk full"));
      return Promise.resolve(undefined);
    });

    await expect(
      saveDpoFeedback("/project", {
        prompt: "Q",
        chosen: "A",
        rejected: "B",
        model_provider: "ollama",
        model_name: "m",
        model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
        timestamp: "2026-06-26T12:00:00.000Z",
      }),
    ).rejects.toThrow(/Failed to save DPO feedback/);
  });

  it("writes valid JSONL line matching the DpoEntry schema", async () => {
    setLocal("nolock.rlhf.dpoEnabled", "true");

    let writtenContent = "";
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "append_to_file") {
        writtenContent = args?.content || "";
      }
      return Promise.resolve(undefined);
    });

    await saveDpoFeedback("/p", {
      prompt: "How?",
      chosen: "Do this.",
      rejected: "Do that.",
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.5, max_tokens: 1024, system_prompt: "Be kind" },
      timestamp: "2026-06-26T12:00:00.000Z",
    });

    expect(writtenContent.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.prompt).toBe("How?");
    expect(parsed.chosen).toBe("Do this.");
    expect(parsed.rejected).toBe("Do that.");
    expect(parsed.model_provider).toBe("ollama");
    expect(parsed.model_name).toBe("qwen3:8b");
    expect(parsed.model_configurations.temperature).toBe(0.5);
    expect(parsed.model_configurations.max_tokens).toBe(1024);
    expect(parsed.model_configurations.system_prompt).toBe("Be kind");
    expect(parsed.timestamp).toBe("2026-06-26T12:00:00.000Z");
    // DpoEntry should not have user_correction
    expect(parsed.user_correction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// saveRlhfFeedback (deprecated wrapper)
// ---------------------------------------------------------------------------

describe("saveRlhfFeedback (deprecated)", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
  });

  it("delegates good feedback to KTO format via append_to_file", async () => {
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

    // Should produce the same JSONL path as saveKtoFeedback with label:true
    expect(path).toBe("/my/project/.rlhf/dpo/good/ollama_qwen3_8b/data.jsonl");
    expect(mockInvoke).toHaveBeenCalledWith("append_to_file", {
      path: "/my/project/.rlhf/dpo/good/ollama_qwen3_8b/data.jsonl",
      content: expect.any(String),
    });

    // Verify the content is a valid JSONL line with the mapped fields
    const callArgs = mockInvoke.mock.calls.find(
      (c: any[]) => c[0] === "append_to_file",
    );
    const content = callArgs?.[1]?.content || "";
    const parsed = JSON.parse(content.trim());
    expect(parsed.prompt).toBe("What is Rust?");
    expect(parsed.completion).toBe("Rust is a systems language.");
    expect(parsed.label).toBe(true);
    expect(parsed.model_provider).toBe("ollama");
    expect(parsed.model_name).toBe("qwen3:8b");
    // Old field names should NOT be present
    expect(parsed.feedback_type).toBeUndefined();
    expect(parsed.question).toBeUndefined();
    expect(parsed.answer).toBeUndefined();
  });

  it("delegates bad feedback with correction to KTO format", async () => {
    await saveRlhfFeedback("/p", {
      feedback_type: "bad",
      model_provider: "ollama",
      model_name: "qwen3:8b",
      model_configurations: { temperature: 0.7, max_tokens: 2048, system_prompt: "" },
      timestamp: "2026-06-26T12:00:00.000Z",
      question: "Q",
      answer: "A",
      user_correction: "Fix it",
    });

    const callArgs = mockInvoke.mock.calls.find(
      (c: any[]) => c[0] === "append_to_file",
    );
    const content = callArgs?.[1]?.content || "";
    const parsed = JSON.parse(content.trim());
    expect(parsed.label).toBe(false);
    expect(parsed.prompt).toBe("Q");
    expect(parsed.completion).toBe("A");
    expect(parsed.user_correction).toBe("Fix it");
  });

  it("returns empty string when RLHF is disabled", async () => {
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
});
