// ---------------------------------------------------------------------------
// Unit tests for the hooks runtime (src/lib/hooks.ts)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import {
  commandMatches,
  normalizeHookConfig,
  checkCommandTrigger,
  subscribeHooks,
  getHookRuns,
  type HookRunEvent,
} from "../hooks";
import { mockInvoke } from "../../test/tauri-mock";

describe("commandMatches", () => {
  it("matches leading words of the executed command", () => {
    expect(commandMatches("git commit -m hello", "git commit")).toBe(true);
  });

  it("does not match partial words", () => {
    expect(commandMatches("git committed", "git commit")).toBe(false);
  });

  it("does not match when the executed command has fewer words", () => {
    expect(commandMatches("git", "git commit")).toBe(false);
  });

  it("does not match a different command", () => {
    expect(commandMatches("git push", "git commit")).toBe(false);
  });

  it("matches exact commands", () => {
    expect(commandMatches("git push --force", "git push --force")).toBe(true);
  });

  it("never matches an empty pattern", () => {
    expect(commandMatches("git commit", "")).toBe(false);
    expect(commandMatches("", "")).toBe(false);
  });
});

describe("normalizeHookConfig", () => {
  it("parses a command trigger with agent fields", () => {
    const cfg = normalizeHookConfig({
      name: "commit-review",
      description: "Review staged changes.",
      trigger: { type: "command", command: "git commit" },
      agent: { name: "code-reviewer", prompt: "", skills: ["code-review"], tools: ["read_file", "grep"] },
    });
    expect(cfg.name).toBe("commit-review");
    expect(cfg.description).toBe("Review staged changes.");
    expect(cfg.trigger).toEqual({ type: "command", command: "git commit" });
    expect(cfg.agent.name).toBe("code-reviewer");
    expect(cfg.agent.skills).toEqual(["code-review"]);
    expect(cfg.agent.tools).toEqual(["read_file", "grep"]);
  });

  it("parses a cron trigger", () => {
    const cfg = normalizeHookConfig({
      name: "daily",
      description: "",
      trigger: { type: "cron", schedule: "0 9 * * 1-5" },
      agent: {},
    });
    expect(cfg.trigger).toEqual({ type: "cron", schedule: "0 9 * * 1-5" });
    expect(cfg.agent.skills).toEqual([]);
    expect(cfg.agent.tools).toEqual([]);
  });

  it("handles garbage input defensively", () => {
    const cfg = normalizeHookConfig(null);
    expect(cfg.name).toBe("");
    expect(cfg.trigger.type).toBe("command");
    expect(cfg.agent.prompt).toBe("");
    expect(cfg.agent.skills).toEqual([]);
  });
});

describe("checkCommandTrigger", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
  });

  it("fires matching command-triggered hooks through the bus", async () => {
    localStorage.setItem("nolock.chatModel", "qwen3:8b");
    const events: HookRunEvent[] = [];
    const unsub = subscribeHooks((e) => events.push(e));

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_hooks") {
        return Promise.resolve([{ name: "commit-review", path: "/p/.hooks/commit-review.yaml" }]);
      }
      if (cmd === "read_hook") {
        return Promise.resolve({
          name: "commit-review",
          description: "Review staged changes.",
          trigger: { type: "command", command: "git commit" },
          agent: { prompt: "Review the diff.", skills: [], tools: [] },
        });
      }
      if (cmd === "ai_chat") {
        return Promise.resolve({ content: "Looks good.", tool_calls: [] });
      }
      return Promise.resolve(undefined);
    });

    await checkCommandTrigger("/p", "git commit -m 'wip'", "terminal");

    const starts = events.filter((e) => e.type === "run-start");
    const dones = events.filter((e) => e.type === "run-done");
    expect(starts).toHaveLength(1);
    expect(dones).toHaveLength(1);
    expect(starts[0].run.hookName).toBe("commit-review");
    expect(starts[0].run.reason).toEqual({
      kind: "command",
      command: "git commit -m 'wip'",
      source: "terminal",
    });
    expect(dones[0].run.output).toBe("Looks good.");
    expect(dones[0].run.status).toBe("done");

    unsub();
  });

  it("does not fire hooks whose trigger does not match", async () => {
    const events: HookRunEvent[] = [];
    const unsub = subscribeHooks((e) => events.push(e));

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_hooks") {
        return Promise.resolve([{ name: "push-hook", path: "/p/.hooks/push-hook.yaml" }]);
      }
      if (cmd === "read_hook") {
        return Promise.resolve({
          name: "push-hook",
          trigger: { type: "command", command: "git push" },
          agent: {},
        });
      }
      return Promise.resolve(undefined);
    });

    await checkCommandTrigger("/p", "git commit", "terminal");
    expect(events).toHaveLength(0);
    unsub();
  });

  it("reports an error run when no chat model is configured", async () => {
    const events: HookRunEvent[] = [];
    const unsub = subscribeHooks((e) => events.push(e));

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_hooks") {
        return Promise.resolve([{ name: "h", path: "/p/.hooks/h.yaml" }]);
      }
      if (cmd === "read_hook") {
        return Promise.resolve({
          name: "h",
          trigger: { type: "command", command: "git commit" },
          agent: {},
        });
      }
      return Promise.resolve(undefined);
    });

    await checkCommandTrigger("/p", "git commit", "terminal");

    const errs = events.filter((e) => e.type === "run-error");
    expect(errs).toHaveLength(1);
    expect(errs[0].run.error).toContain("No chat model");
    unsub();
  });

  it("does nothing when rootPath is empty", async () => {
    await checkCommandTrigger("", "git commit", "terminal");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("registers finished runs in the session registry", async () => {
    localStorage.setItem("nolock.chatModel", "qwen3:8b");
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_hooks") {
        return Promise.resolve([{ name: "h", path: "/p/.hooks/h.yaml" }]);
      }
      if (cmd === "read_hook") {
        return Promise.resolve({ name: "h", trigger: { type: "command", command: "git commit" }, agent: {} });
      }
      if (cmd === "ai_chat") {
        return Promise.resolve({ content: "ok", tool_calls: [] });
      }
      return Promise.resolve(undefined);
    });

    await checkCommandTrigger("/p", "git commit", "terminal");
    const runs = getHookRuns().filter((r) => r.hookName === "h" && r.status === "done");
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[runs.length - 1].output).toBe("ok");
  });
});
