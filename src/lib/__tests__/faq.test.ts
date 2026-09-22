import { nameFaqCategories, parseFaqCategoryName } from "../faq";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";
import {
  faqDir,
  faqJsonPath,
  faqReadmePath,
  joinRepoPath,
  readFaqReadme,
  FAQ_DIR_NAME,
  DEFAULT_EMBEDDING_MODEL,
  defaultFaqConfig,
  getFaqConfig,
  setFaqConfig,
  faqSearch,
  faqUpsert,
  faqList,
  faqDelete,
  faqListCategories,
  faqCreateCategory,
  faqSetEntryCategory,
  faqUpdateEntry,
  faqDeleteEntry,
} from "../faq";

const ROOT = "/repo";

describe("path helpers", () => {
  it("locates .faq artifacts under the repo root", () => {
    expect(FAQ_DIR_NAME).toBe(".faq");
    expect(joinRepoPath(ROOT, ".faq", "faq.duckdb")).toBe("/repo/.faq/faq.duckdb");
    expect(faqDir(ROOT)).toBe("/repo/.faq");
    expect(faqReadmePath(ROOT)).toBe("/repo/.faq/README.md");
    expect(faqJsonPath(ROOT)).toBe("/repo/.faq/.faq.json");
  });
});

describe("readFaqReadme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the README when it exists", async () => {
    mockInvoke.mockResolvedValue("1. What is a router? — asked 2 times\n");
    const content = await readFaqReadme(ROOT);
    expect(content).toContain("What is a router?");
    expect(mockInvoke).toHaveBeenCalledWith("read_file", {
      path: "/repo/.faq/README.md",
    });
  });

  it("returns '' when the .faq has not been created yet", async () => {
    mockInvoke.mockRejectedValue("ENOENT");
    expect(await readFaqReadme(ROOT)).toBe("");
  });

  it("returns '' without a root path", async () => {
    expect(await readFaqReadme("")).toBe("");
  });
});

describe("learning config", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to nomic-embed-text / hybrid / top 3", () => {
    const cfg = getFaqConfig();
    expect(cfg.embeddingModel).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(cfg.ranking).toBe("hybrid");
    expect(cfg.topK).toBe(3);
  });

  it("round-trips through localStorage", () => {
    setFaqConfig({ embeddingModel: "bge-m3", ranking: "semantic", topK: 5, minSimilarity: 0.9 });
    const cfg = getFaqConfig();
    expect(cfg.embeddingModel).toBe("bge-m3");
    expect(cfg.ranking).toBe("semantic");
    expect(cfg.topK).toBe(5);
  });

  it("ignores invalid stored ranking / out-of-range topK", () => {
    localStorage.setItem("nolock.faqEmbeddingModel", "  ");
    localStorage.setItem("nolock.faqRanking", "bogus");
    localStorage.setItem("nolock.faqTopK", "999");
    const cfg = getFaqConfig();
    expect(cfg.embeddingModel).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(cfg.ranking).toBe("hybrid");
    expect(cfg.topK).toBe(3);
  });

  it("defaultFaqConfig is always valid", () => {
    const cfg = defaultFaqConfig();
    expect(cfg.embeddingModel).toBeTruthy();
    expect(["semantic", "frequency", "hybrid"]).toContain(cfg.ranking);
    expect(cfg.topK).toBeGreaterThanOrEqual(1);
  });
});

describe("faq command wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("nolock.chatBackend", "ollama");
    localStorage.setItem("nolock.url", "http://localhost:11434");
    localStorage.setItem("nolock.apiKey.ollama", "local-key");
  });

  it("faqSearch skips empty queries/roots", async () => {
    expect(await faqSearch("/repo", "   ")).toEqual([]);
    expect(await faqSearch("", "hello")).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("faqSearch forwards rootPath, auth, query and config to faq_search", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      return Promise.resolve([{ id: 1, question: "q", answer: "a", frequency: 1 }]);
    });
    setFaqConfig({ embeddingModel: "nomic-embed-text", ranking: "frequency", topK: 2, minSimilarity: 0.85 });
    const hits = await faqSearch("/repo", "how do retries work?");
    expect(hits.length).toBe(1);
    const call = mockInvoke.mock.calls.find((c) => c[0] === "faq_search");
    expect(call).toBeTruthy();
    const [cmd, args] = call as [string, any];
    expect(cmd).toBe("faq_search");
    expect(args.rootPath).toBe("/repo");
    expect(args.query).toBe("how do retries work?");
    expect(args.backend).toBe("ollama");
    expect(args.url).toBe("http://localhost:11434");
    expect(args.apiKey).toBe("local-key");
    expect(args.config.embeddingModel).toBe("nomic-embed-text");
    expect(args.config.ranking).toBe("frequency");
    expect(args.config.topK).toBe(2);
  });

  it("faqUpsert persists question + answer, model and backend", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      return Promise.resolve({ id: 7, question: "q", answer: "a", frequency: 1 });
    });
    const entry = await faqUpsert("/repo", "q?", "a.", "qwen3:8b", "ollama");
    expect(entry.id).toBe(7);
    const call = mockInvoke.mock.calls.find((c) => c[0] === "faq_upsert") as any;
    expect(call[1].question).toBe("q?");
    expect(call[1].answer).toBe("a.");
    expect(call[1].model).toBe("qwen3:8b");
    expect(call[1].backend).toBe("ollama");
    expect(call[1].config.ranking).toBe("hybrid");
  });

  it("faqList returns entries without auth", async () => {
    mockInvoke.mockResolvedValue([{ id: 1, question: "q", answer: "a", frequency: 2 }]);
    const entries = await faqList("/repo");
    expect(entries.length).toBe(1);
    expect(mockInvoke).toHaveBeenCalledWith("faq_list", { rootPath: "/repo" });
  });

  it("faqDelete skips when root or question is missing", async () => {
    await faqDelete("/repo", "  ");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("faqListCategories forwards the topK bound and returns categories", async () => {
    mockInvoke.mockResolvedValue({
      categories: [{ id: 1, name: "Tool loop", isAuto: true, size: 2, entries: [] }],
      uncategorized: [],
    });
    const result = await faqListCategories("/repo", 3);
    expect(result.categories.length).toBe(1);
    expect(result.categories[0].isAuto).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("faq_list_categories", { rootPath: "/repo", topK: 3, minSimilarity: 0.85 });
    // Custom threshold + clamped bound.
    await faqListCategories("/repo", 500, 0.9);
    expect(mockInvoke).toHaveBeenCalledWith("faq_list_categories", { rootPath: "/repo", topK: 50, minSimilarity: 0.9 });
    await faqListCategories("/repo", 2, -1);
    expect(mockInvoke).toHaveBeenCalledWith("faq_list_categories", { rootPath: "/repo", topK: 2, minSimilarity: 0.85 });
  });

  it("faqCreateCategory forwards name and returns the category", async () => {
    mockInvoke.mockResolvedValue({ id: 9, name: "Concepts", isAuto: false, size: 0, entries: [] });
    const cat = await faqCreateCategory("/repo", "Concepts");
    expect(cat.id).toBe(9);
    expect(cat.isAuto).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith("faq_create_category", { rootPath: "/repo", name: "Concepts" });
  });

  it("faqSetEntryCategory maps null to un-assign", async () => {
    mockInvoke.mockResolvedValue(null);
    await faqSetEntryCategory("/repo", 7, null);
    expect(mockInvoke).toHaveBeenCalledWith("faq_set_entry_category", { rootPath: "/repo", entryId: 7, categoryId: null });
    await faqSetEntryCategory("/repo", 8, 3);
    expect(mockInvoke).toHaveBeenCalledWith("faq_set_entry_category", { rootPath: "/repo", entryId: 8, categoryId: 3 });
  });

  it("faqUpdateEntry sends edits + auth + config", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      return Promise.resolve({ id: 7, question: "q2?", answer: "a2", frequency: 1 });
    });
    const entry = await faqUpdateEntry("/repo", 7, "q2?", "a2", 3, "qwen3:8b", "ollama");
    expect(entry.question).toBe("q2?");
    const call = mockInvoke.mock.calls.find((c) => c[0] === "faq_update_entry") as any;
    expect(call[1].id).toBe(7);
    expect(call[1].question).toBe("q2?");
    expect(call[1].answer).toBe("a2");
    expect(call[1].categoryId).toBe(3);
    expect(call[1].model).toBe("qwen3:8b");
    expect(call[1].backend).toBe("ollama");
    expect(call[1].config.ranking).toBe("hybrid");
  });

  it("faqDeleteEntry forwards the entry id", async () => {
    mockInvoke.mockResolvedValue(null);
    await faqDeleteEntry("/repo", 42);
    expect(mockInvoke).toHaveBeenCalledWith("faq_delete_entry", { rootPath: "/repo", id: 42 });
  });
});

describe("chat category names", () => {
  const pending = () => ({ categories: [{ id: 1, name: "Topic 1", isAuto: true, needsName: true, size: 1,
    entries: [{ id: 1, question: "How do I reset my password?", answer: "", frequency: 1, lastAsked: 0, updatedAt: 0 }] }], uncategorized: [] });
  beforeEach(() => { resetTauriMocks(); localStorage.clear(); });
  it("prompts the local model and persists its concise label", async () => {
    localStorage.setItem("nolock.chatBackend", "ollama");
    localStorage.setItem("nolock.chatModel", "qwen3:8b");
    mockInvoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "faq_category_name" ? "Account access" : null));
    await nameFaqCategories("/repo", pending());
    expect(mockInvoke).toHaveBeenCalledWith("faq_category_name", { req: expect.objectContaining({
      backend: "ollama", model: "qwen3:8b", toolsEnabled: [], systemPrompt: expect.stringContaining("2–5 words"),
    }) });
    expect(mockInvoke).toHaveBeenCalledWith("faq_rename_category", { rootPath: "/repo", id: 1, name: "Account access", automatic: true });
  });
  it("uses the main chat provider and model, never the configured FIM model", async () => {
    localStorage.setItem("nolock.chatBackend", "openrouter");
    localStorage.setItem("nolock.chatModel", "main-chat-model");
    localStorage.setItem("nolock.fitmBackend", "ollama");
    localStorage.setItem("nolock.completionModel", "fim-only-model");
    mockInvoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "faq_category_name" ? "Account access" : null));
    await nameFaqCategories("/repo", pending());
    expect(mockInvoke).toHaveBeenCalledWith("faq_category_name", { req: expect.objectContaining({ backend: "openrouter", model: "main-chat-model" }) });
  });
  it("does not silently substitute FIM or legacy models when chat is unset", async () => {
    localStorage.setItem("nolock.completionModel", "fim-only-model");
    localStorage.setItem("nolock.model", "legacy-fim-model");
    await expect(nameFaqCategories("/repo", pending())).rejects.toThrow("Select a chat model");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
  it("does not let one failed category prevent later names from being generated", async () => {
    localStorage.setItem("nolock.chatModel", "qwen3:8b");
    const data = pending();
    data.categories.push({ ...data.categories[0], id: 2 });
    let attempt = 0;
    mockInvoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "faq_category_name" ? (++attempt <= 2 ? "Topic five" : "Account access") : null));
    await expect(nameFaqCategories("/repo", data)).rejects.toThrow("Could not name 1 category");
    expect(mockInvoke).toHaveBeenCalledWith("faq_rename_category", { rootPath: "/repo", id: 2, name: "Account access", automatic: true });
    expect(mockInvoke.mock.calls.some((c) => c[0] === "faq_rename_category" && (c[1] as any).id === 1)).toBe(false);
  });
  it("rejects the question itself and leaves the category available for retry", async () => {
    localStorage.setItem("nolock.chatModel", "qwen3:8b");
    mockInvoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "faq_category_name" ? "How do I reset my password?" : null));
    await expect(nameFaqCategories("/repo", pending())).rejects.toThrow("after two attempts");
    expect(mockInvoke.mock.calls.some((c) => c[0] === "faq_rename_category")).toBe(false);
  });
});


describe("category response parsing", () => {
  it.each([
    ['{"category":"Account access"}', "Account access"],
    ['```json\n{"category":"Account access"}\n```', "Account access"],
    ['<think>Consider the subject.</think>\n{"category":"Account access"}', "Account access"],
    ['Category: "Account access"\nThese questions concern signing in.', "Account access"],
    ['**Account access**', "Account access"],
    ['Managing access to shared team accounts', "Managing access to shared team accounts"],
  ])("extracts a usable label from %s", (response, expected) => {
    expect(parseFaqCategoryName(response, ["How do I sign in?"])).toBe(expected);
  });
  it.each(['', '<think>Still thinking', 'Topic five', '{"category":42}',
    '{"category":"How do I sign in?"}', 'First choice\nSecond choice', 'x'.repeat(61)])("rejects unusable output %s", (response) => {
    expect(parseFaqCategoryName(response, ["How do I sign in?"])).toBeNull();
  });
  it("corrects invalid output once and persists the returned JSON label", async () => {
    resetTauriMocks();
    localStorage.clear();
    localStorage.setItem("nolock.chatModel", "hf.co/impacte/ullr-2.6B-GGUF:latest");
    let attempt = 0;
    mockInvoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "faq_category_name"
      ? (++attempt === 1 ? "Here is a detailed answer to your questions about signing in and resetting passwords." : '{"category":"Account access"}') : null));
    await nameFaqCategories("/repo", { categories: [{ id: 5, name: "Topic 5", isAuto: true, needsName: true, size: 1,
      entries: [{ id: 1, question: "How do I sign in?", answer: "", frequency: 1, lastAsked: 0, updatedAt: 0 }] }], uncategorized: [] });
    expect(attempt).toBe(2);
    const requests = mockInvoke.mock.calls.filter((c) => c[0] === "faq_category_name");
    expect((requests[1][1] as any).req.messages).toHaveLength(3);
    expect((requests[1][1] as any).req.messages[2].content).toContain('Return only {"category"');
    expect(mockInvoke).toHaveBeenCalledWith("faq_rename_category", { rootPath: "/repo", id: 5, name: "Account access", automatic: true });
  });
});
