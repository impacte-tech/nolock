import { describe, it, expect, beforeEach } from "vitest";
import {
  buildSessionMessageLog,
  summarizeMessages,
  summarizeUsage,
  enrichUsage,
  type SessionUsageEntry,
} from "../sessions";

describe("buildSessionMessageLog", () => {
  it("logs every user prompt (display + API content) and assistant tool calls", () => {
    const log = buildSessionMessageLog(
      [
        { role: "user", content: "Context:\nWorking directory: /x\n\n---\nhello", displayContent: "hello", toolCalls: null },
        {
          role: "assistant",
          content: "done",
          toolCalls: [
            { name: "read_file", arguments: '{"path":"/x/a.ts"}', result_snippet: "export const a = 1" },
          ],
        },
      ],
      1000,
    );

    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      role: "user",
      displayContent: "hello",
      content: "Context:\nWorking directory: /x\n\n---\nhello",
      createdAt: 1000,
    });
    expect(typeof log[0].tokens).toBe("number");
    expect(log[1].toolCalls?.[0]).toMatchObject({
      name: "read_file",
      arguments: '{"path":"/x/a.ts"}',
      result_snippet: "export const a = 1",
    });
  });

  it("persists empty-content messages (e.g. hook result placeholders) without crashing", () => {
    const log = buildSessionMessageLog([
      { role: "user", content: "", displayContent: "", toolCalls: null },
    ] as any, 5);
    expect(log[0].role).toBe("user");
    expect(log[0].content).toBe("");
  });
});

describe("summarizeMessages / summarizeUsage", () => {
  beforeEach(() => localStorage.clear());

  it("summarizes from the first user display content", () => {
    const s = summarizeMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "expanded", displayContent: "implement the feature" },
    ]);
    expect(s).toBe("implement the feature");
  });

  it("groups per-request usage by provider + model and sums tokens/cost", () => {
    const usage: SessionUsageEntry[] = [
      { provider: "openrouter", model: "a/b", promptTokens: 1000, completionTokens: 200, totalTokens: 1200, cost: 0.01 },
      { provider: "openrouter", model: "a/b", promptTokens: 500, completionTokens: 100, totalTokens: 600, cost: 0.005 },
      { provider: "ollama", model: "qwen3", promptTokens: 400, completionTokens: 40, totalTokens: 440, cost: null },
    ];

    const s = summarizeUsage(usage);
    expect(s.totalTokens).toBe(2240);
    expect(s.totalCost).toBeCloseTo(0.015);
    expect(s.rows).toHaveLength(2);
    const or = s.rows.find((r) => r.provider === "openrouter");
    expect(or).toBeDefined();
    expect(or!.promptTokens).toBe(1500);
    expect(or!.completionTokens).toBe(300);
    expect(or!.totalTokens).toBe(1800);
    expect(or!.cost).toBeCloseTo(0.015);
  });

  it("returns no cost when no pricing is known", () => {
    const s = summarizeUsage([
      { provider: "ollama", model: "qwen3", promptTokens: 400, completionTokens: 40, totalTokens: 440, cost: null },
    ]);
    expect(s.totalCost).toBeNull();
  });

  it("enrichUsage attaches price/cost from the pricing cache", () => {
    localStorage.setItem("nolock.modelPrices", JSON.stringify({ "openai/gpt-4o": { prompt: 2.5, completion: 10 } }));
    const enriched = enrichUsage([
      { provider: "openrouter", model: "openai/gpt-4o", promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 },
    ]);
    expect(enriched[0].promptPricePerM).toBe(2.5);
    expect(enriched[0].completionPricePerM).toBe(10);
    expect(enriched[0].cost).toBeCloseTo(7.5);
  });

  it("counts the model requests (iterations) behind each row", () => {
    const s = summarizeUsage([
      { provider: "openrouter", model: "a/b", promptTokens: 100, completionTokens: 10, totalTokens: 110 },
      { provider: "openrouter", model: "a/b", promptTokens: 200, completionTokens: 20, totalTokens: 220 },
      { provider: "openrouter", model: "a/b", promptTokens: 300, completionTokens: 30, totalTokens: 330 },
    ]);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].requests).toBe(3);
    expect(s.rows[0].totalTokens).toBe(660);
  });

  it("sums thinking tokens per row and session-wide without double counting", () => {
    // Thinking tokens are an itemized breakdown ALREADY included in
    // completion/total — the summary must surface them without inflating totals.
    const s = summarizeUsage([
      { provider: "openrouter", model: "deepseek/r1", promptTokens: 1000, completionTokens: 300, totalTokens: 1300, thinkingTokens: 120 },
      { provider: "openrouter", model: "deepseek/r1", promptTokens: 1000, completionTokens: 200, totalTokens: 1200, thinkingTokens: 80 },
      { provider: "ollama", model: "qwen3", promptTokens: 400, completionTokens: 40, totalTokens: 440 },
    ]);
    expect(s.totalTokens).toBe(2940);
    expect(s.totalThinkingTokens).toBe(200);
    const r1 = s.rows.find((r) => r.model === "deepseek/r1");
    expect(r1!.thinkingTokens).toBe(200);
    expect(r1!.totalTokens).toBe(2500);
    const local = s.rows.find((r) => r.provider === "ollama");
    expect(local!.thinkingTokens).toBe(0);
  });

  it("refreshes row prices from later entries (price cache filled mid-session)", () => {
    const s = summarizeUsage([
      { provider: "openrouter", model: "a/b", promptTokens: 100, completionTokens: 10, totalTokens: 110 },
      {
        provider: "openrouter", model: "a/b", promptTokens: 100, completionTokens: 10, totalTokens: 110,
        promptPricePerM: 2, completionPricePerM: 8, cost: 0.0008,
      },
    ]);
    // The first entry had no pricing; the row must still surface the price
    // discovered by the second request instead of showing "—".
    expect(s.rows[0].promptPricePerM).toBe(2);
    expect(s.rows[0].completionPricePerM).toBe(8);
    expect(s.rows[0].cost).toBeCloseTo(0.0008);
  });

  it("flags the total as a lower bound when some models have no pricing", () => {
    const s = summarizeUsage([
      { provider: "openrouter", model: "a/b", promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cost: 2.5 },
      { provider: "ollama", model: "qwen3", promptTokens: 10, completionTokens: 0, totalTokens: 10, cost: null },
    ]);
    expect(s.totalCost).toBeCloseTo(2.5);
    expect(s.partialCost).toBe(true);
  });

  it("does not flag partial cost when every model is priced", () => {
    // Note: local providers (ollama/llamacpp) can never be priced — use two
    // remote models with cached prices for the "fully priced" scenario.
    localStorage.setItem(
      "nolock.modelPrices",
      JSON.stringify({ "a/b": { prompt: 1, completion: 1 }, "c/d": { prompt: 0.5, completion: 0.5 } }),
    );
    const s = summarizeUsage([
      { provider: "openrouter", model: "a/b", promptTokens: 100, completionTokens: 0, totalTokens: 100 },
      { provider: "openrouter", model: "c/d", promptTokens: 100, completionTokens: 0, totalTokens: 100 },
    ]);
    expect(s.partialCost).toBe(false);
    expect(s.totalCost).not.toBeNull();
  });

  it("never prices local providers — cost stays unavailable, not $0", () => {
    // Even with a stale zero price cached for the model id, Ollama / llama.cpp
    // entries must report "cost unavailable" ("—"), never "$0".
    localStorage.setItem(
      "nolock.modelPrices",
      JSON.stringify({ "qwen3": { prompt: 0, completion: 0 } }),
    );
    const enriched = enrichUsage([
      { provider: "ollama", model: "qwen3", promptTokens: 400, completionTokens: 40, totalTokens: 440 },
      { provider: "llamacpp", model: "mistral-7b", promptTokens: 400, completionTokens: 40, totalTokens: 440 },
    ]);
    for (const e of enriched) {
      expect(e.promptPricePerM).toBeNull();
      expect(e.completionPricePerM).toBeNull();
      expect(e.cost).toBeNull();
    }
    const s = summarizeUsage(enriched);
    expect(s.totalCost).toBeNull();
    expect(s.partialCost).toBe(false);
  });
});