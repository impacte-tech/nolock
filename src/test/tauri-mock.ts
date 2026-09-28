// ---------------------------------------------------------------------------
// Tauri API mocks for use in Vitest tests.
// These mock the unstable APIs that Tauri polyfills: @tauri-apps/api/core,
// @tauri-apps/api/event, @tauri-apps/plugin-dialog, @tauri-apps/plugin-shell.
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
export const mockListen = vi.fn(
  (_event: string, _handler: (...args: any[]) => void) => Promise.resolve(vi.fn()),
);

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
}

export function resetLocalStorageMocks(store?: Map<string, string>) {
  if (store) store.clear();
}
