import { describe, it, expect } from "vitest";
import { splitReviewText } from "../faqReview";
describe("review chunking", () => {
  it("preserves every source character across Unicode, paragraphs, code and long lines", () => {
    const source = "Question 😀\n\n" + "α🧠 xyz ".repeat(160) + "\n\n```ts\n" + "const a = 1;".repeat(100) + "\n```\n";
    const chunks = splitReviewText(source, 100);
    expect(chunks.map(c => c.text).join("")).toBe(source);
    expect(chunks.every(c => Array.from(c.text).length <= 100)).toBe(true);
    expect(chunks.every(c => !/[\uD800-\uDBFF]$/.test(c.text))).toBe(true);
  });
  it("handles empty input and invalid limits without losing data", () => {
    expect(splitReviewText("")).toEqual([]);
    const source = "a".repeat(500);
    for (const limit of [0, -1, NaN, Infinity]) expect(splitReviewText(source, limit).map(c => c.text).join("")).toBe(source);
  });
});
