import { describe, it, expect, beforeEach } from "vitest";
import {
  cacheModelPrices,
  loadModelPrices,
  getModelPrice,
  calcCost,
  formatCurrency,
} from "../pricing";

describe("pricing cache", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores and merges model prices in localStorage", () => {
    cacheModelPrices({ "openai/gpt-4o": { prompt: 2.5, completion: 10 } });
    cacheModelPrices({ "deepseek/deepseek-chat": { prompt: 0.14, completion: 0.28 } });
    expect(loadModelPrices()).toEqual({
      "openai/gpt-4o": { prompt: 2.5, completion: 10 },
      "deepseek/deepseek-chat": { prompt: 0.14, completion: 0.28 },
    });
  });

  it("reads a known price and returns null for unknown models", () => {
    cacheModelPrices({ "openai/gpt-4o": { prompt: 2.5, completion: 10 } });
    expect(getModelPrice("openai/gpt-4o")).toEqual({ prompt: 2.5, completion: 10 });
    expect(getModelPrice("unknown/model")).toBeNull();
    expect(getModelPrice(null)).toBeNull();
    expect(getModelPrice("")).toBeNull();
  });

  it("tolerates corrupt cache JSON", () => {
    localStorage.setItem("nolock.modelPrices", "{not json");
    expect(loadModelPrices()).toEqual({});
    expect(getModelPrice("anything")).toBeNull();
  });
});

describe("calcCost", () => {
  it("computes cost from per-1M prices", () => {
    const cost = calcCost({ prompt: 2.5, completion: 10 }, 1_000_000, 500_000);
    expect(cost).toBeCloseTo(7.5); // 2.5 + 5.0
  });

  it("returns null when pricing is unknown", () => {
    expect(calcCost(null, 1000, 500)).toBeNull();
    expect(calcCost(undefined, 1000, 500)).toBeNull();
  });
});

describe("formatCurrency", () => {
  it("formats small and large amounts", () => {
    expect(formatCurrency(0.000123)).toBe("$0.00012");
    expect(formatCurrency(0.015)).toBe("$0.015");
    expect(formatCurrency(1.5)).toBe("$1.50");
    expect(formatCurrency(0)).toBe("$0");
  });

  it("renders unknown costs as an em dash", () => {
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(undefined)).toBe("—");
    expect(formatCurrency(Number.NaN)).toBe("—");
  });
});