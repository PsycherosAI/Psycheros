//! Minimal Tauri plugin wrapping the `request_mic_permission` command.
//!
//! ## Why a plugin, not a plain `#[tauri::command]`?
//!
//! Tauri 2's ACL only resolves **plugin-namespaced** commands for remote
//! origins (e.g. `http://localhost:3000`). Plain app commands registered
//! via `tauri::generate_handler!` are silently rejected with
//! `Command <name> not allowed by ACL` when called from any non-default
//! origin, regardless of what capability entries exist.
//!
//! The Psycheros voice UI runs at `http://localhost:3000` (loaded by the
//! Tauri webview when it navigates to the daemon), so we need the plugin
//! namespace. JS invokes this as `plugin:mic|request_mic_permission`.
//!
//! See `capabilities/psycheros-daemon.json` for the matching
//! `mic:allow-request-mic-permission` permission entry.

/// Pre-request macOS microphone permission before the webview's
/// `getUserMedia` call. Calls `AVCaptureDevice.requestAccess` natively,
/// which writes the same TCC entry the system prompt would.
///
/// On Windows/Linux: no-op, returns `Ok(true)`. Those platforms handle
/// mic permission via the normal browser flow inside WebView2/webkit2gtk.
#[tauri::command]
pub async fn request_mic_permission() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(request_mic_permission_blocking)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(target_os = "macos")]
fn request_mic_permission_blocking() -> Result<bool, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    let (tx, rx) = mpsc::sync_channel::<bool>(1);

    // The completion handler is `void(^)(BOOL granted)`. RcBlock owns
    // the block on the heap and keeps the captured `tx` alive until the
    // handler runs (which may be much later — user takes their time
    // answering the prompt).
    let handler = RcBlock::new(move |granted: Bool| {
        let _ = tx.send(granted.as_bool());
    });

    // AVMediaTypeAudio is an NSString whose value is the four-char-code
    // "soun". Constructing it directly avoids pulling in
    // objc2-av-foundation just to look up one constant.
    let media_type = NSString::from_str("soun");

    // requestAccessForMediaType:completionHandler: is asynchronous; the
    // completion handler fires on an internal queue whenever the user
    // resolves the prompt (or immediately if they've already granted).
    unsafe {
        let cls = class!(AVCaptureDevice);
        let _: () = msg_send![
            cls,
            requestAccessForMediaType: &*media_type,
            completionHandler: &*handler,
        ];
    }

    // 60s ceiling so a user who walks away from the prompt doesn't hold
    // the voice-call click open forever.
    rx.recv_timeout(Duration::from_secs(60))
        .map_err(|e| format!("mic permission response timeout: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn request_mic_permission_blocking() -> Result<bool, String> {
    Ok(true)
}

/// Plugin entry point. Registered in `lib.rs` via `.plugin(mic_plugin::init())`.
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("mic")
        .invoke_handler(tauri::generate_handler![request_mic_permission])
        .build()
}
