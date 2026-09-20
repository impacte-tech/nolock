import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockInvoke } from "../../test/tauri-mock";
import {
  faqDir,
  faqJsonPath,
  faqReadmePath,
  joinRepoPath,
  readFaqReadme,
  FAQ_DIR_NAME,
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