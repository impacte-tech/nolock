// ---------------------------------------------------------------------------
// FAQ knowledge base — the "Learning" chat mode.
//
// Learning mode keeps the repository's `.faq/` directory as plain text that
// the chat model itself maintains: its system prompt instructs it to create
// the directory, track every question the user asks, and rewrite a ranked
// README so the most-asked questions rank first.
//
// This frontend module only exposes the folder conventions and a best-effort
// reader used to inject the current FAQ into the conversation context. The
// chat model does the writing directly with its file tools.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";

export const FAQ_DIR_NAME = ".faq";

/** Join a root path and file parts with "/" (Rust std::fs accepts "/" everywhere). */
export function joinRepoPath(rootPath: string, ...parts: string[]): string {
  return [rootPath.replace(/[\\/]+$/, ""), ...parts].join("/");
}

export function faqDir(rootPath: string): string {
  return joinRepoPath(rootPath, FAQ_DIR_NAME);
}

export function faqJsonPath(rootPath: string): string {
  return joinRepoPath(rootPath, FAQ_DIR_NAME, ".faq.json");
}

export function faqReadmePath(rootPath: string): string {
  return joinRepoPath(rootPath, FAQ_DIR_NAME, "README.md");
}

/**
 * Read the FAQ README (if the chat model has created one). Best-effort: a
 * missing/uncreated `.faq/` simply returns "" — the Learning system prompt
 * directs the model to create and maintain it.
 */
export async function readFaqReadme(rootPath: string): Promise<string> {
  if (!rootPath) return "";
  try {
    return await invoke<string>("read_file", { path: faqReadmePath(rootPath) });
  } catch {
    return "";
  }
}