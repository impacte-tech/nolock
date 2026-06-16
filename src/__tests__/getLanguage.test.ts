// ---------------------------------------------------------------------------
// Unit tests for the getLanguage() language-mapping function.
// Duplicated here (the function is private in Editor.tsx) for isolated
// testing of the mapping logic.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

function getLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", html: "html", css: "css",
    json: "json", md: "markdown", yaml: "yaml", yml: "yaml",
    toml: "toml", sh: "shell", bash: "shell", dockerfile: "dockerfile",
  };
  return map[ext] || "plaintext";
}

describe("getLanguage", () => {
  it("maps .ts to typescript", () => {
    expect(getLanguage("file.ts")).toBe("typescript");
  });

  it("maps .tsx to typescript", () => {
    expect(getLanguage("Component.tsx")).toBe("typescript");
  });

  it("maps .js to javascript", () => {
    expect(getLanguage("script.js")).toBe("javascript");
  });

  it("maps .jsx to javascript", () => {
    expect(getLanguage("Component.jsx")).toBe("javascript");
  });

  it("maps .py to python", () => {
    expect(getLanguage("app.py")).toBe("python");
  });

  it("maps .rs to rust", () => {
    expect(getLanguage("lib.rs")).toBe("rust");
  });

  it("maps .go to go", () => {
    expect(getLanguage("main.go")).toBe("go");
  });

  it("maps .html to html", () => {
    expect(getLanguage("index.html")).toBe("html");
  });

  it("maps .css to css", () => {
    expect(getLanguage("styles.css")).toBe("css");
  });

  it("maps .json to json", () => {
    expect(getLanguage("data.json")).toBe("json");
  });

  it("maps .md to markdown", () => {
    expect(getLanguage("README.md")).toBe("markdown");
  });

  it("maps .yaml and .yml to yaml", () => {
    expect(getLanguage("config.yaml")).toBe("yaml");
    expect(getLanguage("config.yml")).toBe("yaml");
  });

  it("maps .toml to toml", () => {
    expect(getLanguage("Cargo.toml")).toBe("toml");
  });

  it("maps .sh and .bash to shell", () => {
    expect(getLanguage("script.sh")).toBe("shell");
    expect(getLanguage("script.bash")).toBe("shell");
  });

  it("maps Dockerfile (no extension) to dockerfile", () => {
    expect(getLanguage("Dockerfile")).toBe("dockerfile");
  });

  it("returns plaintext for unknown extensions", () => {
    expect(getLanguage("file.xyz")).toBe("plaintext");
  });

  it("returns plaintext for files without extension", () => {
    expect(getLanguage("Makefile")).toBe("plaintext");
  });

  it("is case-insensitive", () => {
    expect(getLanguage("File.TS")).toBe("typescript");
    expect(getLanguage("File.PY")).toBe("python");
  });

  it("handles deep paths correctly", () => {
    expect(getLanguage("/home/user/project/src/components/Button.tsx")).toBe("typescript");
  });
});
