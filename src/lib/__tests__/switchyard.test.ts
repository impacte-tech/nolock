import { describe, it, expect } from "vitest";
import {
  type SwitchyardConfig,
  deriveWeights,
  normalizeConfig,
  emptyConfig,
  emptyRoute,
  ROUTE_ALGORITHMS,
} from "../switchyard";

describe("switchyard lib", () => {
  it("emptyConfig is disabled with no routes", () => {
    expect(emptyConfig()).toEqual({ enabled: false, routes: [] });
  });

  it("emptyRoute has sensible defaults", () => {
    const route = emptyRoute();
    expect(route.purpose).toBe("chat");
    expect(route.algorithm).toBe("random");
    expect(route.targets).toEqual([]);
  });

  it("deriveWeights returns undefined for non-random routes", () => {
    const route = { ...emptyRoute(), algorithm: "passthrough" as const };
    expect(deriveWeights(route)).toBeUndefined();
  });

  it("deriveWeights returns undefined when no target has a weight", () => {
    const route = {
      ...emptyRoute(),
      targets: [
        { id: "a", label: "A", backend: "openrouter", model: "m1" },
        { id: "b", label: "B", backend: "openrouter", model: "m2" },
      ],
    };
    expect(deriveWeights(route)).toBeUndefined();
  });

  it("deriveWeights maps per-target weights, defaulting missing ones to 1", () => {
    const route = {
      ...emptyRoute(),
      targets: [
        { id: "a", label: "A", backend: "openrouter", model: "m1", weight: 3 },
        { id: "b", label: "B", backend: "openrouter", model: "m2" },
      ],
    };
    expect(deriveWeights(route)).toEqual([3, 1]);
  });

  it("normalizeConfig strips empty optional fields and derives weights", () => {
    const config: SwitchyardConfig = {
      enabled: true,
      routes: [
        {
          name: "nemotron-family",
          purpose: "chat",
          algorithm: "random",
          targets: [
            { id: "ultra", label: "Ultra", backend: "openrouter", model: "nvidia/nemotron-ultra", weight: 2 },
            { id: "lightning", label: "Lightning", backend: "openrouter", model: "nvidia/nemotron-3.5-lightning" },
          ],
          fallback: "",
        },
      ],
    };
    const normalized = normalizeConfig(config);
    expect(normalized.routes[0].weights).toEqual([2, 1]);
    expect(normalized.routes[0].fallback).toBeUndefined();
    expect(normalized.routes[0].targets[0].weight).toBe(2);
    expect(normalized.routes[0].targets[1].weight).toBeUndefined();
  });

  it("exposes the custom judge algorithm (N-target routing)", () => {
    // The working `.routers/switchyard.json` (nemotron 3-tier) uses
    // `algorithm: "custom"` — the UI/lib must model it.
    expect(ROUTE_ALGORITHMS.map((a) => a.value)).toContain("custom");
    const route = emptyRoute();
    route.algorithm = "custom";
    expect(route.algorithm).toBe("custom");
  });

  it("normalizeConfig keeps a custom judge's prompt/schema/selector and strips empties", () => {
    const schema = {
      type: "object",
      required: ["route"],
      properties: { route: { type: "string", enum: ["lightning", "super", "ultra"] } },
    };
    const config: SwitchyardConfig = {
      enabled: true,
      routes: [
        {
          name: "nemotron-3-tier",
          purpose: "chat",
          algorithm: "custom",
          targets: [
            { id: "lightning", label: "Lightning", backend: "openrouter", model: "nvidia/nemotron-3.5-lightning", costPer1k: 0.00008 },
            { id: "super", label: "Super", backend: "openrouter", model: "z-ai/glm-5.3-flash", costPer1k: 0.00075 },
            { id: "ultra", label: "Ultra", backend: "openrouter", model: "anthropic/claude-fable-5.1", costPer1k: 0.1 },
          ],
          judge: {
            backend: "ollama",
            model: "nemotron-nano-9b",
            prompt: "Pick the least powerful model that can complete the task.",
            responseSchema: schema,
            selector: "/route",
            baseThreshold: NaN as unknown as number, // must be stripped
          },
          fallback: "super",
        },
      ],
    };
    const normalized = normalizeConfig(config);
    const judge = normalized.routes[0].judge!;
    expect(judge.prompt).toContain("least powerful model");
    expect(judge.responseSchema).toEqual(schema);
    expect(judge.selector).toBe("/route");
    expect(judge.baseThreshold).toBeUndefined();
    expect(normalized.routes[0].fallback).toBe("super");
    // costPer1k survives normalization (cost accounting / cost-aware routing).
    expect(normalized.routes[0].targets[0].costPer1k).toBe(0.00008);
  });

  it("normalizeConfig drops an empty judge entirely", () => {
    const config: SwitchyardConfig = {
      enabled: true,
      routes: [
        {
          name: "r",
          purpose: "chat",
          algorithm: "random",
          targets: [{ id: "a", label: "A", backend: "openrouter", model: "m" }],
          judge: { backend: "openrouter", model: "" },
        },
      ],
    };
    const normalized = normalizeConfig(config);
    expect(normalized.routes[0].judge).toBeUndefined();
  });
});