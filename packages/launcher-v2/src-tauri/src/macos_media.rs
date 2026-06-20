//! One-shot WKWebView private-API fix for the missing `navigator.mediaDevices`
//! surface inside the Tauri macOS webview.
//!
//! ## Bug context
//!
//! WKWebView does not expose `navigator.mediaDevices` (or `getUserMedia`) at
//! all unless the host app flips several private WebKit flags on its
//! configuration. This is the underlying cause of voice chat failing inside
//! the Psycheros desktop app on macOS — the API surface is missing, not just
//! the permission prompt.
//!
//! Upstream `wry` had a fix using these private APIs. It was reverted because
//! private API use triggers App Store rejection, and wry targets
//! MAS-compatible builds. Psycheros ships ad-hoc signed
//! (`signingIdentity: "-"` in `tauri.conf.json`) with no MAS distribution
//! goal, so the same restriction does not apply. See
//! `packages/launcher-v2/CLAUDE.md` "Traps that bite" → "WKWebView's
//! getUserMedia..." for the full bug + workaround rationale, and
//! `encapsulated-growing-dewdrop.md` for the implementation plan.
//!
//! ## Three layers
//!
//! 1. **KVC `_allowedMediaCapture = YES`** on `WKWebViewConfiguration` —
//!    makes `navigator.mediaDevices` exist at all.
//! 2. **`_setRequiresUserActionForMediaCapture:NO`** selector on the config
//!    — lets `getUserMedia` run programmatically without a user gesture.
//!    Probed via `respondsToSelector:` because the selector name has
//!    shifted across macOS versions (older was
//!    `_setMediaCaptureRequiresAction:`).
//! 3. **KVC `mediaCaptureEnabled = YES`** on `WKPreferences` —
//!    hard-enables the feature flag.
//!
//! Combined with the existing `request_mic_permission` TCC pre-grant (which
//! handles macOS-level permission) and wry's existing `WKUIDelegate` (which
//! grants the webview-level request when TCC passes), this is enough for
//! voice chat to work identically to the browser.

#[cfg(target_os = "macos")]
pub fn enable_media_capture(window: &tauri::WebviewWindow) {
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{ns_string, NSNumber, NSObjectNSKeyValueCoding};
    use objc2_web_kit::{WKPreferences, WKWebView, WKWebViewConfiguration};

    // with_webview on macOS hands us a PlatformWebview whose `.webview` field
    // is the raw WKWebView pointer (*mut c_void). Caveat
    // (tauri-apps/tauri#15210): the closure over-retains the webview on
    // macOS — fine for a one-shot selector call, just don't store the
    // pointer past the closure.
    let _ = window.with_webview(|webview| unsafe {
        // PlatformWebview.webview is *mut c_void → cast to WKWebView.
        let wv = webview.webview;
        let wk: Option<Retained<WKWebView>> = Retained::retain(wv as *mut WKWebView);
        let wk = match wk {
            Some(wk) => wk,
            None => return,
        };
        let config: Retained<WKWebViewConfiguration> = wk.configuration();

        // Layer 1: expose the navigator.mediaDevices surface. Without this
        // key the JS bindings for mediaDevices aren't even compiled in.
        let yes = NSNumber::numberWithBool(true);
        config.setValue_forKey(Some(&yes), ns_string!("_allowedMediaCapture"));

        // Layer 2: programmatic getUserMedia without a user gesture. Probe
        // before sending — selector name has shifted across macOS versions.
        let cls = class!(WKWebViewConfiguration);
        let responds: Bool = msg_send![
            cls,
            respondsToSelector: sel!(_setRequiresUserActionForMediaCapture:)
        ];
        if responds.as_bool() {
            let _: () = msg_send![
                &config,
                _setRequiresUserActionForMediaCapture: Bool::new(false),
            ];
        }

        // Layer 3: feature flag on preferences.
        let prefs: Retained<WKPreferences> = config.preferences();
        prefs.setValue_forKey(Some(&yes), ns_string!("mediaCaptureEnabled"));
    });
}

#[cfg(not(target_os = "macos"))]
pub fn enable_media_capture(_window: &tauri::WebviewWindow) {
    // WebView2 (Windows) and webkit2gtk (Linux) handle mediaDevices via the
    // normal browser permission flow — no private-API gymnastics required.
    // This function exists as a no-op so the lib.rs setup hook can call it
    // unconditionally without #[cfg] noise at the call site.
}
