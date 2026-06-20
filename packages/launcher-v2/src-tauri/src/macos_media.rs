//! Diagnostic probe for WKWebView mediaDevices availability.
//!
//! ## History
//!
//! An earlier version of this file tried to flip private WebKit KVC keys
//! (`_allowedMediaCapture`) and selectors (`_setRequiresUserActionForMediaCapture:`)
//! to make `navigator.mediaDevices` appear inside the desktop webview.
//! Research later confirmed those keys were never used by upstream wry —
//! they were a hallucination in the original plan. The code was useless.
//!
//! Wry 0.55.1 (the version in our `Cargo.lock`) already auto-grants
//! `getUserMedia` on macOS via `WryWebViewUIDelegate::request_media_capture_permission`
//! which calls the decision handler with `WKPermissionDecision::Grant`
//! unconditionally. So in theory `navigator.mediaDevices` should work
//! out of the box. In practice the friend's test shows it doesn't.
//!
//! ## Current role
//!
//! This module now exists purely as a diagnostic. When the launcher
//! starts, it logs what the WKWebView setup looks like so we can see
//! what's happening on the friend's Mac and stop guessing. Output goes
//! to the launcher's stderr (visible via the tray → View Logs action).
//!
//! Read-only inspection only — no KVC writes, no selectors that mutate
//! state.

#[cfg(target_os = "macos")]
pub fn enable_media_capture(window: &tauri::WebviewWindow) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyClass;
    use objc2::{class, msg_send, sel};
    use objc2_foundation::NSString;
    use objc2_web_kit::WKWebView;

    eprintln!("[macos_media] enable_media_capture starting");

    let _ = window.with_webview(|webview| unsafe {
        eprintln!("[macos_media] with_webview closure fired");

        let wv = webview.inner();
        eprintln!("[macos_media] raw webview pointer = {:p}", wv);

        let wk: Option<Retained<WKWebView>> = Retained::retain(wv as *mut WKWebView);
        let wk = match wk {
            Some(wk) => {
                eprintln!("[macos_media] retained as WKWebView OK");
                wk
            }
            None => {
                eprintln!(
                    "[macos_media] FAILED to retain as WKWebView — not actually a WKWebView pointer?"
                );
                return;
            }
        };

        // Log the actual class name — catches the case where wry wraps
        // WKWebView in a custom subclass we didn't know about.
        let cls: Retained<AnyClass> = msg_send![&wk, class];
        let cls_name: Retained<NSString> = msg_send![&cls, description];
        eprintln!("[macos_media] webview class = {}", cls_name.to_string());

        // Probe whether the config responds to the selectors we previously
        // tried to call. If these come back false, the selectors don't exist
        // on this macOS version — which would explain why our earlier
        // KVC approach did nothing.
        let config_cls = class!(WKWebViewConfiguration);
        let probes = [
            ("_setRequiresUserActionForMediaCapture:", sel!(_setRequiresUserActionForMediaCapture:)),
            ("_setMediaCaptureRequiresAction:", sel!(_setMediaCaptureRequiresAction:)),
        ];
        for (name, selector) in probes {
            let responds: bool = msg_send![config_cls, respondsToSelector: selector];
            eprintln!(
                "[macos_media] WKWebViewConfiguration responds to {name}: {responds}"
            );
        }

        eprintln!("[macos_media] diagnostic complete");
    });

    eprintln!("[macos_media] enable_media_capture finished");
}

#[cfg(not(target_os = "macos"))]
pub fn enable_media_capture(_window: &tauri::WebviewWindow) {
    // Non-Apple platforms: no-op. WebView2 / webkit2gtk handle mediaDevices
    // via the standard browser permission flow.
}
