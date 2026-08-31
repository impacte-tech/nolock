import { describe, it, expect } from "vitest";
import {
  type SwitchyardConfig,
  deriveWeights,
  normalizeConfig,
  emptyConfig,
  emptyRoute,
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
});