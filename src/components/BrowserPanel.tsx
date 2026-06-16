import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Props {
  url: string;
  onClose: () => void;
  /** Incremented after every resize drag ends.  Triggers a "page reload"
   *  of the native webview to ensure it snaps to the correct position. */
  resizeEpoch: number;
}

/**
 * Browser panel using a Tauri native Webview.
 *
 * Unlike an HTML `<iframe>`, a Tauri `Webview` is a native OS-level webview
 * (WebKitGTK on Linux) — a full separate browsing context, NOT an iframe.
 * This means it has no X-Frame-Options restrictions: sites like Google that
 * block iframe embedding work here because this is equivalent to a real browser tab.
 *
 * Strategy:
 *   1. Try to create a native webview via a custom Tauri command that uses a
 *      GtkFixed overlay container (for correct positioning on Linux).
 *   2. If the custom command fails (non-Linux platforms), fall back to the
 *      Tauri JS `new Webview()` API (child webview).
 *   3. On URL prop change: close the old webview, create a new one.
 *   4. A ResizeObserver keeps the webview bounds in sync with the container div.
 *   5. On unmount: close the native webview.
 *
 * The toolbar (URL bar, buttons) is rendered as React HTML above the webview area.
 */
export default function BrowserPanel({ url, onClose, resizeEpoch }: Props) {
  const [currentUrl, setCurrentUrl] = useState(url);
  const [inputUrl, setInputUrl] = useState(url);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const labelCounterRef = useRef(0);
  const creationCounterRef = useRef(0);

  /**
   * Try creating the native webview using the custom Rust command (GtkFixed
   * overlay on Linux).  Falls back to the JS `new Webview()` API if the
   * command is not available (macOS / Windows).
   */
  const createWebviewViaRust = useCallback(
    async (targetUrl: string): Promise<boolean> => {
      const el = containerRef.current;
      if (!el) return false;

      const rect = el.getBoundingClientRect();
      try {
        await invoke("create_browser_webview", {
          url: targetUrl,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
        return true;
      } catch (e) {
        console.warn("[nolock] Rust browser command failed, will try JS API:", e);
        return false;
      }
    },
    [],
  );

  /**
   * Fallback: create a child webview via the Tauri JS API
   * (`new Webview()`).  This works on macOS / Windows but has the VBox
   * positioning bug on Linux.
   */
  const createWebviewViaJs = useCallback(
    async (targetUrl: string): Promise<Webview | null> => {
      const el = containerRef.current;
      if (!el) return null;

      const rect = el.getBoundingClientRect();
      const label = `browser-${++labelCounterRef.current}`;
      const thisCreation = ++creationCounterRef.current;
      setLoading(true);

      try {
        const wv = new Webview(getCurrentWindow(), label, {
          url: targetUrl,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          focus: true,
        });

        // Wait for creation confirmation
        await new Promise<void>((resolve, reject) => {
          wv.once("tauri://created", () => resolve());
          wv.once("tauri://error", (e: any) =>
            reject(e?.payload ?? "Webview creation failed"),
          );
        });

        // If this webview was superseded (StrictMode double-mount), discard
        if (!mountedRef.current || thisCreation !== creationCounterRef.current) {
          wv.close().catch(() => {});
          return null;
        }

        return wv;
      } catch (e) {
        console.error("[nolock] Failed to create JS webview:", e);
        return null;
      }
    },
    [],
  );

  // ---- Ref to hold the JS Webview (fallback path) ------------------------
  const jsWebviewRef = useRef<Webview | null>(null);
  // Flag: are we using the Rust path or the JS fallback?
  const usingRustRef = useRef(false);

  // ---- Open URL helper ---------------------------------------------------
  const createWebview = useCallback(
    async (targetUrl: string) => {
      const el = containerRef.current;
      if (!el) return;

      setLoading(true);

      // 1. Close any existing webview
      // Rust path
      if (usingRustRef.current) {
        try {
          await invoke("close_browser_webview");
        } catch (_) {
          /* ignore */
        }
      }
      // JS fallback
      if (jsWebviewRef.current) {
        try {
          await jsWebviewRef.current.close();
        } catch (_) {
          /* ignore */
        }
        jsWebviewRef.current = null;
      }

      // Small delay to let WebKit release HSTS database locks before
      // creating a new webview (mitigates libsoup SQLite warnings).
      await new Promise((r) => setTimeout(r, 50));

      // 2. Create new webview — try Rust first
      const rustOk = await createWebviewViaRust(targetUrl);
      if (rustOk) {
        usingRustRef.current = true;
        setLoading(false);
        return;
      }

      // 3. Rust unavailable — fall back to JS
      usingRustRef.current = false;
      const jsWv = await createWebviewViaJs(targetUrl);
      if (jsWv) {
        jsWebviewRef.current = jsWv;
        jsWv.setAutoResize(true).catch(() => {});
        setLoading(false);
      } else {
        setLoading(false);
      }
    },
    [createWebviewViaRust, createWebviewViaJs],
  );

  // ---- Mount: create initial webview for the initial URL -----------------
  useEffect(() => {
    mountedRef.current = true;
    createWebview(url);

    return () => {
      mountedRef.current = false;
      // Close JS webview if any
      if (jsWebviewRef.current) {
        jsWebviewRef.current.close().catch(() => {});
        jsWebviewRef.current = null;
      }
      // Close Rust webview if any
      if (usingRustRef.current) {
        invoke("close_browser_webview").catch(() => {});
        usingRustRef.current = false;
      }
    };
  }, []); // Intentionally only on mount — url changes are handled below

  // ---- Watch `url` prop changes → navigate --------------------------------
  useEffect(() => {
    createWebview(url);
  }, [url]);

  // ---- Watch `resizeEpoch` — after every resize drag completes, "reload"
  //      the native webview so it snaps to the correct viewport position.
  //      The user observed that a manual page reload fixes positioning
  //      completely — this is the automated equivalent for the webview only.
  useEffect(() => {
    if (resizeEpoch > 0) {
      createWebview(currentUrl);
    }
  }, [resizeEpoch]);

  // ---- Continuous position polling via requestAnimationFrame -------------
  //
  // IMPORTANT: We CANNOT rely on ResizeObserver alone.  ResizeObserver only
  // fires when the element's **size** changes.  When adjacent panels are
  // resized (explorer, chat, terminal), the browser-pane container's
  // **position** (viewport x/y) changes while its size stays the same.
  // The observer silently ignores this, the webview stays at stale
  // viewport coordinates, and it visually overlaps whatever HTML content
  // now occupies that area (e.g. the chat panel).
  //
  // Solution: Use a rAF polling loop every frame that checks BOTH position
  // and size against the last sent values.  IPC is only dispatched when
  // something actually changed (>1px difference).
  //
  // Performance: `getBoundingClientRect()` is virtually free — it reads
  // cached layout data.  The loop is gated on `mountedRef` and auto-stops
  // on unmount.  It runs at ~60fps during drags and is idle (no IPC)
  // when nothing moves.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let rafId: number | null = null;
    let lastSent = { x: 0, y: 0, width: 0, height: 0 };

    const sendPosition = (rect: { x: number; y: number; width: number; height: number }) => {
      if (usingRustRef.current) {
        invoke("update_browser_webview", {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }).catch(() => {});
      } else if (jsWebviewRef.current) {
        const mainWindow = getCurrentWindow();
        mainWindow.outerPosition().then((wp) => {
          mainWindow.scaleFactor().then((sf) => {
            const sx = Math.round(wp.x + rect.x * sf);
            const sy = Math.round(wp.y + rect.y * sf);
            const sw = Math.round(rect.width * sf);
            const sh = Math.round(rect.height * sf);
            jsWebviewRef.current
              ?.setPosition(new LogicalPosition(sx, sy))
              .catch(() => {});
            jsWebviewRef.current
              ?.setSize(new LogicalSize(sw, sh))
              .catch(() => {});
          });
        });
      }
    };

    const poll = () => {
      if (!mountedRef.current) return;
      rafId = requestAnimationFrame(() => {
        if (!mountedRef.current) return;

        const r = el.getBoundingClientRect();
        const current = { x: r.x, y: r.y, width: r.width, height: r.height };

        // Skip if dimensions are zero — webview hasn't been laid out yet
        if (current.width < 10 || current.height < 10) {
          poll();
          return;
        }

        // Only send IPC when something meaningfully changed (>1px diff)
        const dx = Math.abs(current.x - lastSent.x);
        const dy = Math.abs(current.y - lastSent.y);
        const dw = Math.abs(current.width - lastSent.width);
        const dh = Math.abs(current.height - lastSent.height);

        if (dx > 1 || dy > 1 || dw > 1 || dh > 1) {
          lastSent = current;
          sendPosition(current);
        }

        poll(); // continue loop
      });
    };

    poll();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  // ---- Navigation handler (user types URL in toolbar) --------------------
  const navigate = useCallback(
    async (targetUrl: string) => {
      if (!targetUrl) return;
      let finalUrl = targetUrl;
      if (!finalUrl.startsWith("http://") && !finalUrl.startsWith("https://")) {
        finalUrl = "https://" + finalUrl;
      }

      setCurrentUrl(finalUrl);
      setInputUrl(finalUrl);
      await createWebview(finalUrl);
    },
    [createWebview],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      navigate(inputUrl);
    }
  };

  const handleReload = () => {
    navigate(currentUrl);
  };

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <button className="browser-btn" onClick={onClose} title="Close browser">
          &times;
        </button>
        <button className="browser-btn" onClick={handleReload} title="Reload">
          &#x21BB;
        </button>
        <input
          className="browser-url-input"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter URL..."
        />
        <button
          className="browser-btn"
          onClick={() => shellOpen(currentUrl)}
          title="Open in system browser"
        >
          &#x2197;
        </button>
      </div>
      <div className="browser-content" ref={containerRef}>
        {loading && <div className="browser-loading">Loading...</div>}
      </div>
    </div>
  );
}
