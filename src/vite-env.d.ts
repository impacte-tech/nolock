/// <reference types="vite/client" />

// Injected by vite `define` only when built with VITE_TARGET=web (see
// vite.config.ts). In the desktop build the identifier is never defined, so
// `typeof __WEB_TARGET__` evaluates to "undefined" at runtime.
declare const __WEB_TARGET__: boolean;

// Vite ?inline assets — binary files forced to base64 data URIs.
declare module "*.woff2?inline" {
  const src: string;
  export default src;
}

// katex ships the auto-render extension as a plain ESM file without types
// (its export is `renderMathInElement as default`).
declare module "katex/dist/contrib/auto-render.mjs" {
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
}

declare module "*.svg" {
  const content: string;
  export default content;
}

declare module "*.png" {
  const content: string;
  export default content;
}
