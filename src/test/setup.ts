// ---------------------------------------------------------------------------
// Vitest global setup – runs before every test file.
// ---------------------------------------------------------------------------

import { vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import "./tauri-mock";

// ---------------------------------------------------------------------------
// Polyfill missing DOM APIs that jsdom does not implement
// ---------------------------------------------------------------------------

// matchMedia is not implemented in jsdom (needed by @xterm/xterm)
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// scrollIntoView is not implemented in jsdom
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}

// ResizeObserver is not implemented in jsdom
if (typeof globalThis.ResizeObserver !== "function") {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
}
