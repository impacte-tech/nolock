import { invoke } from "@tauri-apps/api/core";
import { getChatBackend, resolveBackendUrl } from "./backends";
import { getSecret } from "./secrets";
import { getFaqConfig } from "./faq";

export interface ReviewChunk { text: string; summary: string }
export interface FaqReview {
  question: string; answer: string; category: string; chunks: ReviewChunk[];
  model: string; backend: string; revision: number;
}
export interface ReviewPreview { review: FaqReview | null; categories: string[] }
/** Lossless paragraph-first splitting, bounded in Unicode characters (not model tokens). */
export function splitReviewText(text: string, maxCharacters = 2000): ReviewChunk[] {
  const limit = Math.max(100, Math.min(8000, Math.floor(maxCharacters) || 2000));
  const chars = Array.from(text);
  const chunks: ReviewChunk[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(chars.length, start + limit);
    if (end < chars.length) {
      for (let i = end - 1; i > start + limit / 2; i--) {
        if (chars[i] === "\n" && chars[i - 1] === "\n") { end = i + 1; break; }
      }
    }
    const part = chars.slice(start, end).join("");
    chunks.push({ text: part, summary: Array.from(part.trim().split(/\n/)[0] || "").slice(0, 160).join("") });
    start = end;
  }
  return chunks;
}
export function previewFaqReview(rootPath: string, question: string, answer: string): Promise<ReviewPreview> {
  return invoke("faq_review_preview", { rootPath, question, answer });
}
export async function saveFaqReview(rootPath: string, review: FaqReview): Promise<FaqReview> {
  const backend = getChatBackend();
  return invoke("faq_review_save", { rootPath, backend, url: resolveBackendUrl(backend), apiKey: (await getSecret(`apiKey.${backend}`)) || "", review, config: getFaqConfig() });
}
