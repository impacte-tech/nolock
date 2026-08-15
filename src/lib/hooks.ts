// ---------------------------------------------------------------------------
// Hooks runtime — frontend coordinator for the Hooks feature.
//
// Hooks are project-local YAML files in `.hooks/` (managed through the Rust
// `list_hooks` / `read_hook` / `save_hook` commands). A hook defines:
//   - a trigger: a CLI command prefix (`git commit`), a cron schedule, or a
//     manual `!hook-name` signal from chat
//   - an agent run: an optional existing agent (`.agents/`), an inline system
//     prompt, skills to inject (`.skills/`), and an explicit tool set
//
// This module owns the run queue, the pub/sub event bus that feeds the
// "hook run card" UI in the chat panel, and the in-app cron scheduler.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { parseCron, cronMatches } from "./cron";
import { getSecret } from "./secrets";
import { getChatBackend, resolveBackendUrl } from "./backends";

// ---------------------------------------------------------------------------
// Types (mirror the Rust serde structures in src-tauri/src/hooks.rs)
// ---------------------------------------------------------------------------

export type HookTrigger =
  | { type: "cron"; schedule: string }
  | { type: "command"; command: string };

export interface HookAgent {
  name: string;
  prompt: string;
  skills: string[];
  tools: string[];
}

export interface HookConfig {
  name: string;
  description: string;
  trigger: HookTrigger;
  agent: HookAgent;
}

export interface HookEntry {
  name: string;
  path: string;
}

export interface HookEntryWithConfig {
  entry: HookEntry;
  config: HookConfig;
}

export interface ToolCallLog {
  name: string;
  arguments: string;
  result_snippet: string;
  result_full: string;
}

export type HookRunStatus = "queued" | "running" | "done" | "error";

export type TriggerInfo =
  | { kind: "command"; command: string; source: "terminal" | "agent" }
  | { kind: "cron"; schedule: string }
  | { kind: "manual" };

export interface HookRunState {
  id: string;
  hookName: string;
  status: HookRunStatus;
  reason: TriggerInfo;
  output: string;
  toolCalls: ToolCallLog[];
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export type HookRunEvent =
  | { type: "run-start"; run: HookRunState }
  | { type: "run-update"; run: HookRunState }
  | { type: "run-done"; run: HookRunState }
  | { type: "run-error"; run: HookRunState };

// ---------------------------------------------------------------------------
// Pub/sub bus + run registry
// ---------------------------------------------------------------------------

type Listener = (event: HookRunEvent) => void;

const listeners = new Set<Listener>();
const runs = new Map<string, HookRunState>();
let runCounter = 0;

/** Subscribe to hook run events. Returns an unsubscribe function. */
export function subscribeHooks(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** All runs for the current session, oldest first (for replay on mount). */
export function getHookRuns(): HookRunState[] {
  return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Test helper: clears the session run registry, listener set, queue, and
 * counters so module state does not leak between tests.
 */
export function resetHookStateForTests(): void {
  runs.clear();
  listeners.clear();
  queue.length = 0;
  runningCount = 0;
  busy = false;
  runCounter = 0;
}

function emit(event: HookRunEvent) {
  listeners.forEach((l) => {
    try {
      l(event);
    } catch (e) {
      console.error("[hooks] listener error:", e);
    }
  });
}

// ---------------------------------------------------------------------------
// Concurrency: a small FIFO queue. Hook runs and chat generations share the
// `chatBusy` flag — chat input is disabled while a hook runs, and hook runs
// wait in the queue while a chat generation is in flight (avoids colliding on
// the single `stream-token` event used by the chat panel).
// ---------------------------------------------------------------------------

const queue: Array<() => Promise<void>> = [];
let runningCount = 0;
let busy = false;

export function isChatBusy(): boolean {
  return busy;
}

export function setChatBusy(value: boolean) {
  busy = value;
  pumpQueue();
}

function pumpQueue() {
  if (busy) return;
  if (runningCount > 0) return;
  const next = queue.shift();
  if (next) {
    void next();
  }
}

function enqueue(task: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    queue.push(async () => {
      runningCount++;
      try {
        await task();
      } finally {
        runningCount--;
        resolve();
        pumpQueue();
      }
    });
    pumpQueue();
  });
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Defensive parse of the JSON returned by `read_hook`. */
export function normalizeHookConfig(v: unknown): HookConfig {
  const raw = (v ?? {}) as Record<string, unknown>;
  const trigger = (raw.trigger ?? {}) as Record<string, unknown>;
  const agent = (raw.agent ?? {}) as Record<string, unknown>;
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    description: typeof raw.description === "string" ? raw.description : "",
    trigger:
      trigger.type === "cron"
        ? { type: "cron", schedule: typeof trigger.schedule === "string" ? trigger.schedule : "" }
        : { type: "command", command: typeof trigger.command === "string" ? trigger.command : "" },
    agent: {
      name: typeof agent.name === "string" ? agent.name : "",
      prompt: typeof agent.prompt === "string" ? agent.prompt : "",
      skills: Array.isArray(agent.skills) ? agent.skills.map(String) : [],
      tools: Array.isArray(agent.tools) ? agent.tools.map(String) : [],
    },
  };
}

export async function readHookConfig(entry: HookEntry): Promise<HookConfig> {
  const value = await invoke("read_hook", { path: entry.path });
  return normalizeHookConfig(value);
}

/** List all hooks with their parsed configs (skips unreadable files). */
export async function listHookEntriesWithConfig(rootPath: string): Promise<HookEntryWithConfig[]> {
  if (!rootPath) return [];
  const entries = await invoke<HookEntry[]>("list_hooks", { rootPath });
  const result: HookEntryWithConfig[] = [];
  for (const entry of entries) {
    try {
      result.push({ entry, config: await readHookConfig(entry) });
    } catch (e) {
      console.error(`[hooks] failed to read hook ${entry.name}:`, e);
    }
  }
  return result;
}

/** Save a hook through the Rust backend (YAML serialization happens in Rust). */
export async function saveHook(
  rootPath: string,
  name: string,
  config: HookConfig,
): Promise<string> {
  return invoke<string>("save_hook", { rootPath, name, config });
}

// ---------------------------------------------------------------------------
// Command trigger matching
// ---------------------------------------------------------------------------

/**
 * Word-boundary prefix match: `"git commit"` matches `"git commit -m x"` but
 * not `"git committed"` (whole words are compared).
 */
export function commandMatches(executed: string, pattern: string): boolean {
  const execWords = executed.trim().split(/\s+/).filter(Boolean);
  const patternWords = pattern.trim().split(/\s+/).filter(Boolean);
  if (patternWords.length === 0) return false;
  if (execWords.length < patternWords.length) return false;
  for (let i = 0; i < patternWords.length; i++) {
    if (execWords[i] !== patternWords[i]) return false;
  }
  return true;
}

/**
 * Called whenever a CLI command is executed — by the user in a terminal or by
 * the AI's `bash_sandbox` tool. Fires every command-triggered hook that
 * matches the command's leading words.
 */
export async function checkCommandTrigger(
  rootPath: string,
  command: string,
  source: "terminal" | "agent",
): Promise<void> {
  if (!rootPath || !command.trim()) return;
  try {
    const entries = await invoke<HookEntry[]>("list_hooks", { rootPath });
    for (const entry of entries) {
      try {
        const config = await readHookConfig(entry);
        if (config.trigger.type !== "command") continue;
        if (commandMatches(command, config.trigger.command)) {
          await runHook(rootPath, config, {
            kind: "command",
            command: command.trim(),
            source,
          });
        }
      } catch (e) {
        console.error(`[hooks] error checking hook ${entry.name}:`, e);
      }
    }
  } catch (e) {
    console.error("[hooks] checkCommandTrigger error:", e);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function describeTrigger(hook: HookConfig, reason: TriggerInfo): string {
  switch (reason.kind) {
    case "command":
      return `A hook triggered after the command "${reason.command}" was executed ${reason.source === "agent" ? "by an AI agent" : "in the terminal"}.`;
    case "cron":
      return `A scheduled hook triggered at ${new Date().toLocaleTimeString()} (cron schedule: "${reason.schedule}").`;
    case "manual":
      return "This hook was triggered manually.";
  }
}

function buildSystemPrompt(hook: HookConfig, rootPath: string): string {
  const inline = hook.agent.prompt.trim();
  if (inline) return inline;
  const fallback = `You are an automation hook agent for the project at ${rootPath}. ${hook.description ? hook.description : "Perform the requested task and report what you did."}`;
  return fallback;
}

async function resolveAgentPrompt(rootPath: string, agentName: string): Promise<string> {
  if (!agentName.trim()) return "";
  try {
    const entries = await invoke<{ name: string; path: string }[]>("list_agents", { rootPath });
    const match = entries.find((e) => e.name === agentName.trim());
    if (!match) return "";
    const data: { prompt?: string } = await invoke("read_agent", { path: match.path });
    return data.prompt || "";
  } catch (e) {
    console.error(`[hooks] failed to load agent '${agentName}':`, e);
    return "";
  }
}

async function buildSkillContext(rootPath: string, skillNames: string[]): Promise<string[]> {
  const parts: string[] = [];
  for (const skillName of skillNames) {
    try {
      const result: { stdout: string; stderr: string; exit_code: number; content: string } =
        await invoke("run_skill_command", { rootPath, skillName });
      parts.push(`Skill: ${skillName}\n\`\`\`\n${result.content}\n\`\`\``);
      if (result.stdout) {
        parts.push(`Command output (stdout):\n\`\`\`\n${result.stdout}\n\`\`\``);
      }
      if (result.stderr) {
        parts.push(`Command stderr (exit code ${result.exit_code}):\n\`\`\`\n${result.stderr}\n\`\`\``);
      }
    } catch (e) {
      parts.push(`Skill: ${skillName}\n(Error reading skill: ${e})`);
    }
  }
  return parts;
}

function readEnabledTools(): string[] {
  try {
    const raw = localStorage.getItem("nolock.toolsEnabled");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Execute a single hook run — non-streamed, serialized by the queue. */
async function executeHookRun(
  rootPath: string,
  hook: HookConfig,
  reason: TriggerInfo,
): Promise<{ content: string; tool_calls: ToolCallLog[] }> {
  const backend = getChatBackend();
  const url = resolveBackendUrl(backend);
  const chatModel = localStorage.getItem("nolock.chatModel") || "";
  if (!chatModel) {
    throw new Error("No chat model configured. Open AI Integrations settings to set one.");
  }

  const apiKey =
    (await getSecret(`apiKey.${backend}`)) ??
    localStorage.getItem(`nolock.apiKey.${backend}`) ??
    "";

  // System prompt: inline prompt > referenced agent > generic fallback.
  let systemPrompt = hook.agent.prompt.trim();
  if (!systemPrompt) {
    systemPrompt = await resolveAgentPrompt(rootPath, hook.agent.name);
  }
  if (!systemPrompt) {
    systemPrompt = buildSystemPrompt(hook, rootPath);
  }

  const contextParts: string[] = [`Working directory: ${rootPath}`];
  const skillParts = await buildSkillContext(rootPath, hook.agent.skills);
  contextParts.push(...skillParts);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${describeTrigger(hook, reason)}\n\n${contextParts.join("\n\n")}` },
  ];

  const toolsEnabled =
    hook.agent.tools.length > 0 ? hook.agent.tools.map(String) : readEnabledTools();

  let toolConfigs: Record<string, Record<string, string>> = {};
  try {
    const raw = localStorage.getItem("nolock.toolConfig") ?? "{}";
    toolConfigs = JSON.parse(raw);
  } catch {
    toolConfigs = {};
  }

  const chatTemperature = localStorage.getItem("nolock.chatTemperature");
  const chatMaxTokens = localStorage.getItem("nolock.chatMaxTokens");

  const req = {
    backend,
    url,
    model: chatModel,
    messages,
    apiKey: apiKey || null,
    toolsEnabled,
    toolConfigs,
    temperature: chatTemperature ? parseFloat(chatTemperature) : undefined,
    maxTokens: chatMaxTokens ? parseInt(chatMaxTokens, 10) : undefined,
    systemPrompt: undefined,
    rootPath: rootPath || undefined,
    maxIterations: parseInt(localStorage.getItem("nolock.toolMaxIterations") || "10", 10),
  };

  return invoke<{ content: string; tool_calls: ToolCallLog[] }>("ai_chat", { req });
}

/**
 * Queue and run a hook. Resolves when the run has finished (or been skipped
 * because chat is busy and no model is configured, etc.).
 */
export async function runHook(
  rootPath: string,
  hook: HookConfig,
  reason: TriggerInfo,
): Promise<void> {
  const run: HookRunState = {
    id: `hook-${++runCounter}`,
    hookName: hook.name,
    status: "queued",
    reason,
    output: "",
    toolCalls: [],
    startedAt: Date.now(),
  };
  runs.set(run.id, run);
  emit({ type: "run-start", run });

  await enqueue(async () => {
    run.status = "running";
    emit({ type: "run-update", run });
    // Disable chat input while the hook is actively generating.
    setChatBusy(true);
    try {
      const result = await executeHookRun(rootPath, hook, reason);
      run.output = result.content || "";
      run.toolCalls = result.tool_calls || [];
      run.status = "done";
      run.finishedAt = Date.now();
      emit({ type: "run-done", run });
    } catch (e) {
      run.status = "error";
      run.error = String(e);
      run.finishedAt = Date.now();
      emit({ type: "run-error", run });
    } finally {
      setChatBusy(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Cron scheduler (app-open only)
// ---------------------------------------------------------------------------

/**
 * Start the in-app cron scheduler. Every ~10s it checks each cron hook and
 * fires it at most once per matching minute. Returns a cleanup function.
 */
export function startHookScheduler(rootPath: string): () => void {
  if (!rootPath) return () => {};
  let lastMinuteKey = -1;

  const tick = async () => {
    const now = new Date();
    const minuteKey =
      now.getFullYear() * 1_000_000 +
      now.getMonth() * 10_000 +
      now.getDate() * 100 +
      now.getHours() * 60 +
      now.getMinutes();
    if (minuteKey === lastMinuteKey) return;
    lastMinuteKey = minuteKey;

    try {
      const entries = await invoke<HookEntry[]>("list_hooks", { rootPath });
      for (const entry of entries) {
        try {
          const config = await readHookConfig(entry);
          if (config.trigger.type !== "cron") continue;
          if (!config.trigger.schedule.trim()) continue;
          // Validate once — bad schedules are reported, not fatal.
          parseCron(config.trigger.schedule);
          if (cronMatches(config.trigger.schedule, now)) {
            await runHook(rootPath, config, {
              kind: "cron",
              schedule: config.trigger.schedule,
            });
          }
        } catch (e) {
          console.error(`[hooks] bad cron schedule in hook ${entry.name}:`, e);
        }
      }
    } catch (e) {
      console.error("[hooks] scheduler error:", e);
    }
  };

  const interval = setInterval(tick, 10_000);
  // Run an immediate first check on start.
  void tick();
  return () => clearInterval(interval);
}
