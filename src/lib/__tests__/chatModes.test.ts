import { describe, it, expect, beforeEach } from "vitest";
import {
  type ChatMode,
  CHAT_MODES,
  CHAT_MODE_STORAGE_KEY,
  composeChatSystemPrompt,
  getChatMode,
  isChatMode,
  setChatModeStored,
} from "../chatModes";

describe("CHAT_MODES", () => {
  it("defines the three harness modes: building, planning, learning", () => {
    expect(CHAT_MODES.map((m) => m.id)).toEqual(["building", "planning", "learning"]);
    for (const mode of CHAT_MODES) {
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.description.length).toBeGreaterThan(0);
    }
  });
});

describe("composeChatSystemPrompt", () => {
  it("injects nothing for building mode (the current default behavior)", () => {
    expect(composeChatSystemPrompt(null, "building")).toBe("");
    expect(composeChatSystemPrompt("", "building")).toBe("");
    expect(composeChatSystemPrompt("custom", "building")).toBe("custom");
  });

  it("returns the mode block when no custom prompt exists (planning)", () => {
    const out = composeChatSystemPrompt(null, "planning");
    expect(out).toContain("PLANNING MODE");
  });

  it("returns the learning block (plain-text .faq maintenance)", () => {
    const out = composeChatSystemPrompt(null, "learning");
    expect(out).toContain("LEARNING MODE");
    expect(out).toContain("MAINTAIN THE .faq/ KNOWLEDGE BASE AS PLAIN TEXT");
  });

  it("covers the four learning behaviors", () => {
    const block = composeChatSystemPrompt(null, "learning");
    expect(block).toContain("TEACH ADVERSARIALLY");
    expect(block).toContain("DETECT KNOWLEDGE GAPS");
    expect(block).toContain("VALIDATE LEARNING WITH QUESTIONS");
    expect(block).toContain("MAINTAIN THE .faq/ KNOWLEDGE BASE AS PLAIN TEXT");
  });

  it("prepends the custom prompt and appends the mode block", () => {
    const out = composeChatSystemPrompt("Be concise.", "learning");
    expect(out.startsWith("Be concise.")).toBe(true);
    expect(out).toContain("\n\nYou are currently in LEARNING MODE.");
  });
});

describe("getChatMode / setChatModeStored", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to building mode", () => {
    expect(getChatMode()).toBe("building");
  });

  it("round-trips through localStorage", () => {
    setChatModeStored("learning");
    expect(getChatMode()).toBe("learning");
    expect(localStorage.getItem(CHAT_MODE_STORAGE_KEY)).toBe("learning");
  });

  it("falls back to building for an unknown stored value", () => {
    localStorage.setItem(CHAT_MODE_STORAGE_KEY, "unknown-mode");
    expect(getChatMode()).toBe("building");
  });
});

describe("isChatMode", () => {
  it("accepts only the three known modes", () => {
    expect(isChatMode("building")).toBe(true);
    expect(isChatMode("planning")).toBe(true);
    expect(isChatMode("learning")).toBe(true);
    expect(isChatMode("buildingx")).toBe(false);
    expect(isChatMode(123)).toBe(false);
  });
});