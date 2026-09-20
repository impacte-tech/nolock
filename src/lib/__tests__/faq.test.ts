import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockInvoke } from "../../test/tauri-mock";
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
    setFaqConfig({ embeddingModel: "bge-m3", ranking: "semantic", topK: 5 });
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
    setFaqConfig({ embeddingModel: "nomic-embed-text", ranking: "frequency", topK: 2 });
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

  it("faqUpsert persists question + answer with the config", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      return Promise.resolve({ id: 7, question: "q", answer: "a", frequency: 1 });
    });
    const entry = await faqUpsert("/repo", "q?", "a.");
    expect(entry.id).toBe(7);
    const call = mockInvoke.mock.calls.find((c) => c[0] === "faq_upsert") as any;
    expect(call[1].question).toBe("q?");
    expect(call[1].answer).toBe("a.");
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
});