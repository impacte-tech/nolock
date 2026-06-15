// ---------------------------------------------------------------------------
// Native browser webview backed by a GtkOverlay + GtkFixed for precise
// overlay positioning.
//
// PROBLEM: GtkApplicationWindow is a GtkBin (only one child).  The default
// child is a GtkBox (VBox) containing the main webview.  We cannot add a
// second widget directly to the window — so we reparent the VBox into a
// GtkOverlay on first use, then add our GtkFixed as an overlay child.
//
// The GtkFixed is sized/positioned via margins + size-request so it only
// covers the browser content area, letting mouse events pass through to
// the React UI outside that area.
//
// On non‑Linux platforms the commands are stubs that return an error —
// the frontend falls back to Tauri's JS `new Webview()` API.
// ---------------------------------------------------------------------------

// ── Linux: real implementation using GtkOverlay + GtkFixed ────────────────

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
mod imp {
    use gtk::prelude::*;
    use std::sync::Mutex;
    use tauri::{AppHandle, Manager};
    use wry::WebViewBuilderExtUnix;

    // ---- Safe wrappers for !Send GTK / wry types -------------------------
    //
    // SAFETY: these objects are created, accessed and destroyed exclusively
    // on the main thread (via `Window::run_on_main_thread`).  The `Mutex`
    // ensures exclusive write access so there are no races.

    #[allow(dead_code)]
    struct SendOverlay(gtk::Overlay);
    unsafe impl Send for SendOverlay {}

    struct SendFixed(gtk::Fixed);
    unsafe impl Send for SendFixed {}

    struct SendWebView(wry::WebView);
    unsafe impl Send for SendWebView {}

    /// Persistent widget infrastructure (lives for the whole app session).
    /// The overlay is kept alive for its side‑effect (hosting the Fixed widget);
    /// it is never read directly after creation.
    #[allow(dead_code)]
    struct BrowserInfra {
        overlay: SendOverlay,
        fixed: SendFixed,
    }

    /// The currently active browser webview (none while panel is closed).
    pub struct BrowserState {
        infra: Mutex<Option<BrowserInfra>>,
        webview: Mutex<Option<SendWebView>>,
    }

    impl BrowserState {
        pub fn new() -> Self {
            Self {
                infra: Mutex::new(None),
                webview: Mutex::new(None),
            }
        }
    }

    // ---- Helpers ---------------------------------------------------------

    fn get_main_window(app: &AppHandle) -> Result<tauri::Window<tauri::Wry>, String> {
        app.get_window("main")
            .ok_or_else(|| "Main window not found".to_string())
    }

    /// Position / resize the GtkFixed container so it matches the desired
    /// bounds.  This is called both at creation and on every resize.
    fn place_fixed(fixed: &gtk::Fixed, x: f64, y: f64, width: f64, height: f64) {
        fixed.set_halign(gtk::Align::Start);
        fixed.set_valign(gtk::Align::Start);
        fixed.set_margin_start(x as i32);
        fixed.set_margin_top(y as i32);
        fixed.set_size_request(width as i32, height as i32);
        // Make the Fixed widget visible (it is transparent by default).
        fixed.show();
    }

    /// Build a wry WebView inside the given Fixed container, positioned at
    /// the origin of the Fixed with the given size.
    fn build_webview(
        fixed: &gtk::Fixed,
        url: &str,
        width: f64,
        height: f64,
    ) -> Result<wry::WebView, String> {
        let bounds = wry::Rect {
            // The webview sits at (0, 0) inside the Fixed.  The Fixed
            // itself is positioned by place_fixed() via margins.
            position: wry::dpi::LogicalPosition::new(0.0, 0.0).into(),
            size: wry::dpi::LogicalSize::new(width, height).into(),
        };

        wry::WebViewBuilder::new()
            .with_url(url)
            .with_bounds(bounds)
            .build_gtk(fixed)
            .map_err(|e| format!("build_gtk: {e}"))
    }

    /// Set up the GtkOverlay wrapper ONCE.  Called on the first
    /// create_browser_webview invocation.
    fn setup_overlay(
        gtk_window: &gtk::ApplicationWindow,
        window: &tauri::Window<tauri::Wry>,
    ) -> Result<(gtk::Overlay, gtk::Fixed), String> {
        // Get the window's default VBox (the sole child of the GtkBin).
        // It holds the main webview (React UI) and everything else.
        let vbox = window
            .default_vbox()
            .map_err(|e| format!("default_vbox: {e}"))?;

        // Create overlay + fixed.
        let overlay = gtk::Overlay::new();
        let fixed = gtk::Fixed::new();

        // Reparent: remove VBox from window, add overlay, add VBox to
        // overlay as the MAIN (bottom) child.
        gtk_window.remove(&vbox);
        gtk_window.add(&overlay);
        overlay.add(&vbox);

        // The Fixed becomes an OVERLAY child (sits on top of the VBox).
        overlay.add_overlay(&fixed);

        gtk_window.show_all();

        Ok((overlay, fixed))
    }

    // ---- Commands --------------------------------------------------------

    #[tauri::command]
    pub async fn create_browser_webview(
        app: AppHandle,
        url: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        let window = get_main_window(&app)?;
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

        window
            .clone()
            .run_on_main_thread(move || {
                let state = app.state::<BrowserState>();
                let gtk_window = match window.gtk_window() {
                    Ok(w) => w,
                    Err(e) => {
                        let _ = tx.send(Err(format!("gtk_window: {e}")));
                        return;
                    }
                };

                // ---- 1. Set up overlay infrastructure (first time only) ----
                let mut infra_guard = state.infra.lock().unwrap();
                if infra_guard.is_none() {
                    match setup_overlay(&gtk_window, &window) {
                        Ok((overlay, fixed)) => {
                            *infra_guard = Some(BrowserInfra {
                                overlay: SendOverlay(overlay),
                                fixed: SendFixed(fixed),
                            });
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e));
                            return;
                        }
                    }
                }

                let infra = infra_guard.as_ref().unwrap();
                let fixed = &infra.fixed.0;

                // ---- 2. Position the Fixed container -----------------------
                place_fixed(fixed, x, y, width, height);

                // ---- 3. Destroy previous webview if any --------------------
                let mut wv_guard = state.webview.lock().unwrap();
                *wv_guard = None; // dropping the old SendWebView cleans up

                // ---- 4. Build new webview inside the Fixed -----------------
                match build_webview(fixed, &url, width, height) {
                    Ok(wv) => {
                        *wv_guard = Some(SendWebView(wv));
                        let _ = tx.send(Ok(()));
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| format!("run_on_main_thread: {e}"))?;

        rx.recv().map_err(|e| format!("channel recv: {e}"))?
    }

    /// Destroy the browser webview (keep the overlay / fixed infrastructure
    /// in place so the next open is fast).
    #[tauri::command]
    pub async fn close_browser_webview(app: AppHandle) -> Result<(), String> {
        let window = get_main_window(&app)?;
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

        window
            .clone()
            .run_on_main_thread(move || {
                let state = app.state::<BrowserState>();
                let mut wv_guard = state.webview.lock().unwrap();
                *wv_guard = None; // drop the webview
                let _ = tx.send(Ok(()));
            })
            .map_err(|e| format!("run_on_main_thread: {e}"))?;

        rx.recv().map_err(|e| format!("channel recv: {e}"))?
    }

    /// Reposition / resize the browser webview.
    #[tauri::command]
    pub async fn update_browser_webview(
        app: AppHandle,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        let window = get_main_window(&app)?;
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

        window
            .clone()
            .run_on_main_thread(move || {
                let state = app.state::<BrowserState>();

                // Update the Fixed container's position and size.
                let infra_guard = state.infra.lock().unwrap();
                let wv_guard = state.webview.lock().unwrap();

                match (infra_guard.as_ref(), wv_guard.as_ref()) {
                    (Some(infra), Some(wv)) => {
                        place_fixed(&infra.fixed.0, x, y, width, height);

                        // Update the webview bounds within the Fixed.
                        let bounds = wry::Rect {
                            position: wry::dpi::LogicalPosition::new(0.0, 0.0).into(),
                            size: wry::dpi::LogicalSize::new(width, height).into(),
                        };
                        match wv.0.set_bounds(bounds) {
                            Ok(_) => {
                                let _ = tx.send(Ok(()));
                            }
                            Err(e) => {
                                let _ = tx.send(Err(format!("set_bounds: {e}")));
                            }
                        }
                    }
                    _ => {
                        let _ = tx.send(Err("No active browser webview".into()));
                    }
                }
            })
            .map_err(|e| format!("run_on_main_thread: {e}"))?;

        rx.recv().map_err(|e| format!("channel recv: {e}"))?
    }
}

// ── Non‑Linux: stubs that return an error ─────────────────────────────────

#[cfg(not(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
)))]
mod imp {
    pub struct BrowserState;

    impl BrowserState {
        pub fn new() -> Self {
            Self
        }
    }

    #[tauri::command]
    pub async fn create_browser_webview(
        _app: tauri::AppHandle,
        _url: String,
        _x: f64,
        _y: f64,
        _width: f64,
        _height: f64,
    ) -> Result<(), String> {
        Err("Native browser webview is not supported on this platform — use the JS Webview API instead".into())
    }

    #[tauri::command]
    pub async fn close_browser_webview(_app: tauri::AppHandle) -> Result<(), String> {
        Err("Native browser webview is not supported on this platform".into())
    }

    #[tauri::command]
    pub async fn update_browser_webview(
        _app: tauri::AppHandle,
        _x: f64,
        _y: f64,
        _width: f64,
        _height: f64,
    ) -> Result<(), String> {
        Err("Native browser webview is not supported on this platform".into())
    }
}

// ── Public re‑exports ─────────────────────────────────────────────────────

pub use imp::*;
