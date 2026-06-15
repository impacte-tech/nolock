import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Props {
  url: string;
  onClose: () => void;
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
export default function BrowserPanel({ url, onClose }: Props) {
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
        console.warn("[zencode] Rust browser command failed, will try JS API:", e);
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
        console.error("[zencode] Failed to create JS webview:", e);
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

  // ---- ResizeObserver: sync webview bounds when container resizes ----------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      // Use getBoundingClientRect() — entry.contentRect.x/y are relative to
      // the element's own border-box origin (~0), NOT viewport-relative.
      // The Rust command expects viewport-absolute coordinates.
      const rect = el.getBoundingClientRect();

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
    });

    observer.observe(el);
    return () => observer.disconnect();
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
