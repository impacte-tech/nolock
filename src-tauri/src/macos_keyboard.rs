#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
#[cfg(target_os = "macos")]
use objc2::{class, msg_send};
#[cfg(target_os = "macos")]
use tauri::Emitter;

// macOS virtual key codes for the keys we need to intercept
#[cfg(target_os = "macos")]
const KEY_A: u16 = 0x00;
#[cfg(target_os = "macos")]
const KEY_Z: u16 = 0x06;
#[cfg(target_os = "macos")]
const KEY_Y: u16 = 0x10;

// NSEventModifierFlagCommand = 1 << 20
#[cfg(target_os = "macos")]
const CMD_MASK: u64 = 1 << 20;
// NSEventModifierFlagShift = 1 << 17
#[cfg(target_os = "macos")]
const SHIFT_MASK: u64 = 1 << 17;

/// Install a local event monitor on macOS that intercepts Cmd+Z/A/Y
/// before they reach WKWebView's NSResponder chain.
///
/// Consumed events emit Tauri events (`native-cmd-z`, `native-cmd-a`,
/// `native-cmd-y`, `native-cmd-shift-z`) to the webview so the
/// JavaScript handler can call `editor.trigger()` directly.
#[cfg(target_os = "macos")]
pub fn install(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Give the AppKit run loop a moment to be ready
        std::thread::sleep(std::time::Duration::from_millis(200));
        unsafe {
            install_inner(app_handle);
        }
    });
}

#[cfg(target_os = "macos")]
unsafe fn install_inner(app_handle: tauri::AppHandle) {
    let app = app_handle.clone();

    let handler: RcBlock<dyn Fn(*mut AnyObject) -> *mut AnyObject> = RcBlock::new(
        move |event: *mut AnyObject| -> *mut AnyObject {
            if event.is_null() {
                return std::ptr::null_mut();
            }

            // Retrieve key code and modifier flags from the NSEvent
            let key_code: u16 = unsafe { msg_send![event, keyCode] };
            let mod_flags: u64 = unsafe { msg_send![event, modifierFlags] };

            // Only intercept when Command is held
            if (mod_flags & CMD_MASK) == 0 {
                return event;
            }

            match key_code {
                KEY_A => {
                    let _ = app.emit("native-cmd-a", ());
                    // Return nil to consume the event (prevent native selectAll)
                    return std::ptr::null_mut();
                }
                KEY_Z => {
                    let has_shift = (mod_flags & SHIFT_MASK) != 0;
                    if has_shift {
                        let _ = app.emit("native-cmd-shift-z", ());
                    } else {
                        let _ = app.emit("native-cmd-z", ());
                    }
                    return std::ptr::null_mut();
                }
                KEY_Y => {
                    let _ = app.emit("native-cmd-y", ());
                    return std::ptr::null_mut();
                }
                _ => {} // Let all other key events through
            }

            event
        },
    );

    // NSEventMaskKeyDown = 1 << NSEventTypeKeyDown
    // NSEventTypeKeyDown = 10
    let mask: u64 = 1 << 10;

    let cls = class!(NSEvent);
    // The method retains a copy of the block, so we can drop our handle.
    // Pass the block as an id (void pointer). Blocks are Objective-C objects
    // and their struct pointer is compatible with id.
    let _monitor: *mut AnyObject = msg_send![cls,
        addLocalMonitorForEventsMatchingMask: mask,
        handler: &*handler as *const _ as *mut AnyObject
    ];

    // Leak the monitor — it lives for the entire app lifetime.
    // We never need to remove it.
    // Use let _ to suppress the "unused import" / variable warning
    // while keeping the monitor registered with the OS event loop.
    let _ = _monitor;
}

/// Stub for non-macOS platforms.
#[cfg(not(target_os = "macos"))]
pub fn install(_app_handle: tauri::AppHandle) {
    // No-op: Cmd+Z/A/Y are handled correctly by the browser/webview on
    // Linux and Windows because Ctrl is used instead of Cmd.
}
