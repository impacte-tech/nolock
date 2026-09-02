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
});