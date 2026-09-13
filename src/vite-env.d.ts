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

// The katex contrib auto-render module is vendored in src/assets/katex/ and
// typed by its sibling auto-render.d.mts (no ambient declaration needed).

declare module "*.svg" {
  const content: string;
  export default content;
}

declare module "*.png" {
  const content: string;
  export default content;
}
