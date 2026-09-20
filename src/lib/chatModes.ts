// ---------------------------------------------------------------------------
// Chat modes — how the main chat agent behaves.
//
// Two modes are common across coding harnesses:
//   - "building"  — the default: implement, fix and ship what the user asks.
//   - "planning"  — investigate first, produce a plan/design, then implement.
//
// nolock adds a third mode:
//   - "learning"  — flip the main chat agent from "do the work for you" to
//     "make sure you understand the work". The agent tutors the user about
//     their own project (Socratic style), probes for knowledge gaps, validates
//     understanding with questions, and maintains a per-repository `.faq/`
//     knowledge base (plain markdown it writes directly) ranked by frequency.
// ---------------------------------------------------------------------------

export type ChatMode = "building" | "planning" | "learning";

export interface ChatModeDef {
  id: ChatMode;
  label: string;
  description: string;
}

export const CHAT_MODES: ChatModeDef[] = [
  {
    id: "building",
    label: "Building",
    description:
      "Default harness behavior: implement, fix, refactor and ship what you ask.",
  },
  {
    id: "planning",
    label: "Planning",
    description:
      "Investigate the codebase and produce a plan/design before anything is built.",
  },
  {
    id: "learning",
    label: "Learning",
    description:
      "Teach you about your project: probes knowledge gaps, validates understanding, keeps a frequency-ranked .faq/.",
  },
];

export const CHAT_MODE_STORAGE_KEY = "nolock.chatMode";
export const DEFAULT_CHAT_MODE: ChatMode = "building";

export function isChatMode(value: unknown): value is ChatMode {
  return value === "building" || value === "planning" || value === "learning";
}

/** Read the current chat mode from localStorage (safe when unavailable). */
export function getChatMode(): ChatMode {
  try {
    const raw = localStorage.getItem(CHAT_MODE_STORAGE_KEY);
    return isChatMode(raw) ? raw : DEFAULT_CHAT_MODE;
  } catch {
    return DEFAULT_CHAT_MODE;
  }
}

/** Persist the chat mode (safe when localStorage is unavailable). */
export function setChatModeStored(mode: ChatMode): void {
  try {
    localStorage.setItem(CHAT_MODE_STORAGE_KEY, mode);
  } catch {
    // Non-fatal — the session still uses the in-memory mode.
  }
}

// ---------------------------------------------------------------------------
// Per-mode behavior blocks injected into the main chat agent system prompt.
// "building" intentionally injects nothing — it preserves the current default.
// ---------------------------------------------------------------------------

const CHAT_MODE_SYSTEM_PROMPTS: Record<ChatMode, string> = {
  building: "",

  planning: `You are currently in PLANNING MODE. Before writing any code, change or fix:
1. Investigate the request and the relevant parts of the codebase (read files, grep, list directories).
2. Produce a concise plan: what changes are needed, where, and why — with file paths.
3. Confirm the plan addresses the user's request, then implement it.
When the user only asks for a plan (no "implement", "do it", "fix"), stop after the plan.`,

  learning: `You are currently in LEARNING MODE. Unlike the default Building mode, your PRIMARY objective is not to do the work for the user — it is to make the user understand their own project better. Follow these rules, in priority order:

1. TEACH ADVERSARIALLY (Socratic method). Never just hand over an answer. Ask "why", "what if", "how does that interact with X" and make the user reason to the answer. When a prompt reveals a misunderstanding, correct it explicitly and explain the underlying concept with concrete references to this repository's code.

2. DETECT KNOWLEDGE GAPS. Infer from the user's prompts what they do not yet understand about the codebase: imprecise descriptions of code, misuse of terms, questions a confident engineer would not need to ask, pasted code the user cannot explain. Name the gap explicitly ("It sounds like you are not yet comfortable with how X works") and teach toward it.

3. VALIDATE LEARNING WITH QUESTIONS. Throughout the session, ask short check-in questions that confirm mastery before moving on (e.g. "Explain in your own words why the system prompt is merged before the conversation history."). Prefer questions that require the user to articulate an explanation rather than yes/no questions.

4. MAINTAIN THE .faq/ KNOWLEDGE BASE AS PLAIN TEXT. nolock automatically indexes every question → answer exchange into a semantic (vector) store, and past exchanges relevant to the current question are injected into your context as "Learned knowledge". In addition, keep a human-readable ".faq" directory at the repository root (a sibling of .git, src, etc.) updated directly with your file tools (read_file / write_file / edit):
   - If ".faq" does not exist, create it with a "README.md" that lists the questions the user has asked.
   - After every user turn, append any genuinely new question (or bump the entry of a semantically equivalent one) and rewrite "README.md" so the questions asked more often rank FIRST (ties broken by most recently asked).
   - Keep the list human-readable: "N. <question> — asked N time(s)". Use accurate counts — never fabricate them.
   - The machine-indexed "Learned knowledge" injected into your context is authoritative for retrieval; keep this plain-text companion readable for the user, not as your primary memory.`,
};

/**
 * Compose the system prompt actually sent to the main chat agent.
 * A custom prompt from the user (Chat Model panel) is prepended; the
 * mode-specific block (if any) is appended after it so it cannot be
 * accidentally overridden by a generic custom prompt.
 */
export function composeChatSystemPrompt(
  custom: string | null | undefined,
  mode: ChatMode,
): string {
  const modeBlock = CHAT_MODE_SYSTEM_PROMPTS[mode] ?? "";
  if (!custom && !modeBlock) return "";
  if (custom && !modeBlock) return custom;
  if (!custom && modeBlock) return modeBlock;
  return `${custom}\n\n${modeBlock}`;
}