// ---------------------------------------------------------------------------
// Tauri API mocks for use in Vitest tests.
// These mock the unstable APIs that Tauri polyfills: @tauri-apps/api/core,
// @tauri-apps/api/event, @tauri-apps/plugin-dialog, @tauri-apps/plugin-shell,
// @tauri-apps/api/dpi, @tauri-apps/api/webview, @tauri-apps/api/window.
//
// Import this in setup.ts to install all mocks before each test file.
// ---------------------------------------------------------------------------

import { vi } from "vitest";

// ---- @tauri-apps/api/core ------------------------------------------------
export const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => (mockInvoke as any)(...args),
}));

// ---- @tauri-apps/api/event -----------------------------------------------
export const mockListen = vi.fn(() => Promise.resolve(vi.fn()));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: any[]) => (mockListen as any)(...args),
}));

// ---- @tauri-apps/plugin-dialog -------------------------------------------
export const mockDialogOpen = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: any[]) => (mockDialogOpen as any)(...args),
}));

// ---- @tauri-apps/plugin-shell --------------------------------------------
export const mockShellOpen = vi.fn();

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: (...args: any[]) => (mockShellOpen as any)(...args),
}));

// ---- @tauri-apps/api/dpi --------------------------------------------------
vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalPosition: class LogicalPosition {
    x: number;
    y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  },
  LogicalSize: class LogicalSize {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
  },
}));

// ---- @tauri-apps/api/webview ----------------------------------------------
export const MockWebview = vi.fn();
export const mockWebviewClose = vi.fn();
export const mockWebviewOnce = vi.fn();
export const mockWebviewSetAutoResize = vi.fn();
export const mockWebviewSetPosition = vi.fn();
export const mockWebviewSetSize = vi.fn();

vi.mock("@tauri-apps/api/webview", () => ({
  Webview: class Webview {
    label: string;
    constructor(window: unknown, label: string, _options: unknown) {
      this.label = label;
      MockWebview(window, label, _options);
    }
    close = mockWebviewClose;
    once = mockWebviewOnce;
    setAutoResize = mockWebviewSetAutoResize;
    setPosition = mockWebviewSetPosition;
    setSize = mockWebviewSetSize;
  },
}));

// ---- @tauri-apps/api/window -----------------------------------------------
export const mockGetCurrentWindow = vi.fn();
export const mockOuterPosition = vi.fn();
export const mockScaleFactor = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: (...args: unknown[]) => mockGetCurrentWindow(...args),
  // The window object returned by getCurrentWindow
  currentWindow: {
    outerPosition: mockOuterPosition,
    scaleFactor: mockScaleFactor,
  },
}));

// ---- @tauri-apps/api/core also exports the invoke used by Tauri v2 -------
// Already mocked above.

// ---- localStorage mock ----------------------------------------------------
export function setupLocalStorageMocks() {
  const store = new Map<string, string>();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(
    (key: string) => store.get(key) ?? null,
  );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(
    (key: string, value: string) => {
      store.set(key, value);
    },
  );
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(
    (key: string) => {
      store.delete(key);
    },
  );
  vi.spyOn(Storage.prototype, "clear").mockImplementation(() => {
    store.clear();
  });
  return store;
}

// ---- Helpers to reset all mocks between tests -----------------------------
export function resetTauriMocks() {
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockDialogOpen.mockReset();
  mockShellOpen.mockReset();
  MockWebview.mockReset();
  mockWebviewClose.mockReset();
  mockWebviewOnce.mockReset();
  mockWebviewSetAutoResize.mockReset();
  mockWebviewSetPosition.mockReset();
  mockWebviewSetSize.mockReset();
  mockGetCurrentWindow.mockReset();
  mockOuterPosition.mockReset();
  mockScaleFactor.mockReset();

  // Default behaviours
  mockGetCurrentWindow.mockReturnValue({
    outerPosition: mockOuterPosition,
    scaleFactor: mockScaleFactor,
  });
  mockOuterPosition.mockResolvedValue({ x: 0, y: 0 });
  mockScaleFactor.mockResolvedValue(1);
}

export function resetLocalStorageMocks(store?: Map<string, string>) {
  if (store) store.clear();
}
