// ---------------------------------------------------------------------------
// SwitchyardPanel — the UI must map `.routers/switchyard.json` 1:1.
//
// Regression: the panel only knew about passthrough/random/llm-classifier, so
// the working project config (algorithm: "custom" with a judge prompt,
// responseSchema and selector) could not be displayed or edited — loading it
// silently dropped the custom mode. These tests load the REAL working config
// shape and assert the panel renders every field and saves it back intact.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SwitchyardPanel from "../SwitchyardPanel";
import { mockInvoke, resetTauriMocks } from "../../test/tauri-mock";

// Mirrors the project's working `.routers/switchyard.json` (nemotron 3-tier).
const WORKING_CONFIG = {
  enabled: true,
  routes: [
    {
      name: "nemotron-3-tier",
      purpose: "chat",
      algorithm: "custom",
      targets: [
        { id: "lightning", label: "Nemotron 3.5 Lightning", backend: "openrouter", model: "nvidia/nemotron-3.5-lightning", costPer1k: 0.00008 },
        { id: "super", label: "GLM 5.3 Flash", backend: "openrouter", model: "z-ai/glm-5.3-flash", costPer1k: 0.00075 },
        { id: "ultra", label: "Claude Fable 5.1", backend: "openrouter", model: "anthropic/claude-fable-5.1", costPer1k: 0.1 },
      ],
      judge: {
        backend: "ollama",
        model: "nemotron-nano-9b",
        prompt: "You are a model router. Return a JSON verdict with \"route\".",
        responseSchema: {
          type: "object",
          required: ["route"],
          properties: { route: { type: "string", enum: ["lightning", "super", "ultra"] } },
        },
        selector: "/route",
      },
      fallback: "super",
    },
  ],
};

describe("SwitchyardPanel", () => {
  beforeEach(() => {
    resetTauriMocks();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_switchyard_config") return Promise.resolve(WORKING_CONFIG);
      if (cmd === "write_switchyard_config") return Promise.resolve(null);
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("maps a custom-algorithm route from the JSON into editable fields", async () => {
    render(<SwitchyardPanel visible onClose={vi.fn()} rootPath="/root" />);

    // Algorithm is shown as the custom judge mode.
    await waitFor(() => {
      expect(screen.getByText("Custom judge (picks one of N targets)")).toBeInTheDocument();
    });

    // Target ids are editable inputs seeded from the file.
    const lightning = screen.getByDisplayValue("lightning") as HTMLInputElement;
    const superTarget = screen.getByDisplayValue("super") as HTMLInputElement;
    const ultra = screen.getByDisplayValue("ultra") as HTMLInputElement;
    expect(lightning).not.toBeNull();
    expect(superTarget).not.toBeNull();
    expect(ultra).not.toBeNull();

    // Judge prompt + response schema + selector are surfaced.
    expect(
      screen.getByDisplayValue(/You are a model router/) as HTMLTextAreaElement,
    ).not.toBeNull();
    const schemaEditor = screen.getByDisplayValue(/"enum"/) as HTMLTextAreaElement;
    expect(schemaEditor.value).toContain('"route"');
    expect(screen.getByDisplayValue("/route")).not.toBeNull();
  });

  it("saves an untouched custom route back without losing judge fields", async () => {
    render(<SwitchyardPanel visible onClose={vi.fn()} rootPath="/root" />);
    await waitFor(() => {
      expect(screen.getByText("Custom judge (picks one of N targets)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      const writeCall = mockInvoke.mock.calls.find((c) => c[0] === "write_switchyard_config");
      expect(writeCall).toBeTruthy();
      const saved = writeCall![1].config;
      expect(saved.enabled).toBe(true);
      const route = saved.routes[0];
      expect(route.algorithm).toBe("custom");
      expect(route.judge.prompt).toContain("model router");
      expect(route.judge.responseSchema).toEqual(WORKING_CONFIG.routes[0].judge.responseSchema);
      expect(route.judge.selector).toBe("/route");
      expect(route.fallback).toBe("super");
      expect(route.targets.map((t: any) => t.id)).toEqual(["lightning", "super", "ultra"]);
      expect(route.targets[0].costPer1k).toBe(0.00008);
    });
  });

  it("rejects a custom route whose response schema is invalid JSON", async () => {
    render(<SwitchyardPanel visible onClose={vi.fn()} rootPath="/root" />);
    await waitFor(() => {
      expect(screen.getByText("Custom judge (picks one of N targets)")).toBeInTheDocument();
    });

    const schemaEditor = screen.getByDisplayValue(/"enum"/) as HTMLTextAreaElement;
    fireEvent.change(schemaEditor, { target: { value: "{ not json" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText(/not valid JSON/)).toBeInTheDocument();
    });
    // Nothing was written.
    expect(mockInvoke.mock.calls.some((c) => c[0] === "write_switchyard_config")).toBe(false);
  });

  it("rejects a custom route without a fallback target", async () => {
    render(<SwitchyardPanel visible onClose={vi.fn()} rootPath="/root" />);
    await waitFor(() => {
      expect(screen.getByText("Custom judge (picks one of N targets)")).toBeInTheDocument();
    });

    // Clear the fallback selection ("(none)" option).
    fireEvent.click(screen.getByText("super — GLM 5.3 Flash")); // open the fallback menu
    fireEvent.click(screen.getByText("(none)"));
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText(/no fallback target/)).toBeInTheDocument();
    });
    expect(mockInvoke.mock.calls.some((c) => c[0] === "write_switchyard_config")).toBe(false);
  });
});
