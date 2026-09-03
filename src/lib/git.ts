// ---------------------------------------------------------------------------
// Git — typed wrappers around the backend's per-session git commands.
//
// The session summary UI uses these to show the files changed during a session
// (diff between the last commit at/before the session start and the current
// working tree, plus untracked files) and the per-file unified diff.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";

/** A file changed during a session window. */
export interface GitChangedFile {
  /** Repo-root-relative path (the NEW path for renames). */
  path: string;
  /** "added" | "modified" | "deleted" | "renamed" */
  status: string;
  /** Previous path (renames only). */
  oldPath?: string;
  /** Lines added (untracked files: total line count). Null for binary files. */
  insertions?: number | null;
  /** Lines deleted. Null for binary files. */
  deletions?: number | null;
  /** True when the file is untracked (never committed). */
  untracked: boolean;
}

/** The unified git diff of a single file for a session window. */
export interface GitFileDiff {
  path: string;
  status: string;
  /** Previous path (renames only). */
  oldPath?: string;
  /** Raw unified diff (`git diff --no-color`). May be empty. */
  diff: string;
}

/**
 * List the files changed during a session window. `sinceTs` is the session's
 * creation timestamp (unix seconds); the backend diffs the last commit at or
 * before that moment against the current working tree and appends untracked
 * files. Throws when the folder is not inside a git work tree.
 */
export async function listSessionChangedFiles(
  rootPath: string,
  sinceTs: number,
): Promise<GitChangedFile[]> {
  if (!rootPath) return [];
  const result = await invoke<GitChangedFile[]>("git_session_files", {
    rootPath,
    sinceTs,
  });
  // Defensive: tolerate mocks/stubs returning a non-array.
  return Array.isArray(result) ? result : [];
}

/**
 * Fetch the unified git diff of ONE file for a session window. Throws when the
 * folder is not inside a git work tree or the path is invalid.
 */
export async function getSessionFileDiff(
  rootPath: string,
  path: string,
  sinceTs: number,
): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_session_file_diff", {
    rootPath,
    path,
    sinceTs,
  });
}

/** Short badge label for a change status. */
export function gitStatusBadge(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}
