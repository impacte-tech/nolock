// ---------------------------------------------------------------------------
// Unit tests for the getFileColor() color-mapping function.
// Duplicated here (the function is private in FileExplorer.tsx) for isolated
// testing of the color mapping logic.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

function getFileColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (name.toLowerCase() === "dockerfile") return "#4588c4";
  if (name.toLowerCase() === "makefile") return "#e06c75";
  const colorMap: Record<string, string> = {
    ts: "#3178c6", tsx: "#3178c6",
    js: "#f7df1e", jsx: "#f7df1e",
    py: "#4584b6", rs: "#dea584", go: "#00add8",
    html: "#e34c26", css: "#563d7c",
    json: "#cbcb41", md: "#519aba",
    yaml: "#cb171e", yml: "#cb171e",
    toml: "#9c4221", sh: "#89e051", bash: "#89e051",
  };
  return colorMap[ext] || "#6c7086";
}

describe("getFileColor", () => {
  it("returns correct color for .ts files", () => {
    expect(getFileColor("app.ts")).toBe("#3178c6");
  });

  it("returns correct color for .tsx files", () => {
    expect(getFileColor("Component.tsx")).toBe("#3178c6");
  });

  it("returns correct color for .js files", () => {
    expect(getFileColor("app.js")).toBe("#f7df1e");
  });

  it("returns correct color for .py files", () => {
    expect(getFileColor("app.py")).toBe("#4584b6");
  });

  it("returns correct color for .rs files", () => {
    expect(getFileColor("lib.rs")).toBe("#dea584");
  });

  it("returns correct color for .go files", () => {
    expect(getFileColor("main.go")).toBe("#00add8");
  });

  it("returns correct color for .html files", () => {
    expect(getFileColor("index.html")).toBe("#e34c26");
  });

  it("returns correct color for .css files", () => {
    expect(getFileColor("styles.css")).toBe("#563d7c");
  });

  it("returns correct color for .json files", () => {
    expect(getFileColor("data.json")).toBe("#cbcb41");
  });

  it("returns correct color for .md files", () => {
    expect(getFileColor("README.md")).toBe("#519aba");
  });

  it("returns correct color for .yaml and .yml files", () => {
    expect(getFileColor("config.yaml")).toBe("#cb171e");
    expect(getFileColor("config.yml")).toBe("#cb171e");
  });

  it("returns correct color for .toml files", () => {
    expect(getFileColor("Cargo.toml")).toBe("#9c4221");
  });

  it("returns correct color for .sh and .bash files", () => {
    expect(getFileColor("script.sh")).toBe("#89e051");
    expect(getFileColor("script.bash")).toBe("#89e051");
  });

  it("returns special color for Dockerfile", () => {
    expect(getFileColor("Dockerfile")).toBe("#4588c4");
  });

  it("is case-insensitive for Dockerfile", () => {
    expect(getFileColor("dockerfile")).toBe("#4588c4");
    expect(getFileColor("DOCKERFILE")).toBe("#4588c4");
  });

  it("returns special color for Makefile", () => {
    expect(getFileColor("Makefile")).toBe("#e06c75");
  });

  it("is case-insensitive for Makefile", () => {
    expect(getFileColor("makefile")).toBe("#e06c75");
  });

  it("returns fallback color for unknown extensions", () => {
    expect(getFileColor("file.xyz")).toBe("#6c7086");
  });

  it("returns fallback color for files without extension", () => {
    expect(getFileColor("LICENSE")).toBe("#6c7086");
  });

  it("is case-insensitive for extension lookup", () => {
    expect(getFileColor("App.TS")).toBe("#3178c6");
    expect(getFileColor("App.PY")).toBe("#4584b6");
  });

  it("handles dotted filenames correctly", () => {
    expect(getFileColor(".eslintrc.js")).toBe("#f7df1e");
  });
});
