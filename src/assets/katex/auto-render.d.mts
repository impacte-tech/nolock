// Types for the vendored katex auto-render extension (auto-render.mjs).
// Mirrors the interface katex's contrib/auto-render ships; see
// https://katex.org/docs/autorender and src/assets/katex/README.md.

export interface AutoRenderOptions {
  delimiters?: Array<{ left: string; right: string; display: boolean }>;
  ignoredTags?: string[];
  ignoredClasses?: string[];
  throwOnError?: boolean;
  errorCallback?: (msg: string, err: Error) => void;
  macros?: Record<string, string>;
  [key: string]: unknown;
}

export default function renderMathInElement(
  element: HTMLElement,
  options?: AutoRenderOptions,
): void;
