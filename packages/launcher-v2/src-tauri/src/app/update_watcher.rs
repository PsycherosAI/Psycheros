//! Background watcher for upstream source-update availability.
//!
//! Polls `check_for_updates_blocking` on a long interval (currently 3
//! hours) and emits an `update-available` event when the cached state
//! changes. On the false→true transition, also injects a small in-window
//! toast via `webview.eval` so a user in the chat view (different origin
//! from the launcher's own frontend) sees the alert without needing
//! native OS notifications. The toast survives until the user dismisses
//! it via its close button, or until the next page navigation, or until
//! the watcher reports the update is no longer available.
//!
//! Lives on its own thread alongside the daemon-status watcher in
//! [`app::spawn_status_watcher`]. The two are independent: the status
//! watcher pings localhost every 2s for liveness, this one pings GitHub
//! every few hours for new code.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{check_for_launcher_update_blocking, check_for_updates_blocking, LauncherUpdateInfo, UpdateInfo};

/// Event name the frontend listens on. Payload is `UpdateInfo` (shape
/// identical to what the explicit `check_for_updates` command returns).
pub const UPDATE_EVENT: &str = "update-available";

/// Poll cadence. Three hours balances "user finds out within a workday"
/// against "don't hammer GitHub or burn the user's bandwidth." The
/// network call itself is cheap (`git ls-remote`), but each poll wakes
/// a thread and spawns a subprocess; longer is fine.
const POLL_INTERVAL: Duration = Duration::from_secs(3 * 60 * 60);

/// DOM id used for the in-window toast. Centralized so add/remove paths
/// stay in lockstep — if I change the id in one place, both follow.
const TOAST_DOM_ID: &str = "psycheros-update-toast";
const LAUNCHER_TOAST_DOM_ID: &str = "psycheros-launcher-update-toast";

/// Spawn the update watcher. Fires its first poll immediately so a fresh
/// launcher boot surfaces "update available" without the user waiting
/// three hours.
pub fn spawn_update_watcher(handle: AppHandle) {
    let last_available = Arc::new(AtomicBool::new(false));
    let last_launcher_available = Arc::new(AtomicBool::new(false));
    thread::spawn(move || loop {
        // --- Daemon source update check (existing) ---
        match check_for_updates_blocking() {
            Ok(info) => {
                let was = last_available.load(Ordering::SeqCst);
                let now = info.update_available;

                if let Err(e) = handle.emit(UPDATE_EVENT, &info) {
                    eprintln!("[launcher] emit update-available failed: {e}");
                }

                if !was && now {
                    inject_toast(&handle, &info);
                } else if was && !now {
                    remove_toast(&handle);
                }

                last_available.store(now, Ordering::SeqCst);
            }
            Err(e) => {
                eprintln!("[launcher] daemon update check failed: {e}");
            }
        }

        // --- Launcher app update check (new) ---
        // The launcher can't self-update yet, but we surface new versions
        // so users know to download them. This catches critical fixes
        // (like the v0.2.44 snapshot-consistency patch) that would
        // otherwise require users to manually check the releases page.
        match check_for_launcher_update_blocking() {
            Ok(info) => {
                let was = last_launcher_available.load(Ordering::SeqCst);
                let now = info.update_available;

                if !was && now {
                    inject_launcher_toast(&handle, &info);
                } else if was && !now {
                    remove_launcher_toast(&handle);
                }

                last_launcher_available.store(now, Ordering::SeqCst);
            }
            Err(e) => {
                eprintln!("[launcher] launcher update check failed: {e}");
            }
        }
        thread::sleep(POLL_INTERVAL);
    });
}

/// Inject a small status toast at the top-right of the main webview via
/// `webview.eval`. Works across origins — runs in the page's JS context,
/// whether that's the launcher's own splash (`tauri://localhost`) or
/// the daemon's chat UI (`http://localhost:3000`). This is why the
/// styling is inlined: a stylesheet linked from one origin wouldn't
/// load in the other.
fn inject_toast(handle: &AppHandle, info: &UpdateInfo) {
    let current = info
        .current_version
        .as_deref()
        .unwrap_or("(none)")
        .to_string();
    let latest = info
        .latest_version
        .as_deref()
        .unwrap_or("(unknown)")
        .to_string();

    let Some(window) = handle.get_webview_window("main") else {
        eprintln!("[launcher] no main window for toast injection");
        return;
    };

    // The toast's "press <chord> to install" hint needs the platform-
    // appropriate modifier glyph: ⌘ on macOS, Ctrl on Windows/Linux.
    // Hardcoding ⌘ in the template made the Windows toast tell users
    // to press a chord that doesn't exist on their keyboard. We pick
    // the literal at Rust-format time rather than letting JS sniff
    // navigator.platform because the launcher already knows its host.
    #[cfg(target_os = "macos")]
    let install_hint = "Press \u{2318}, to install";
    #[cfg(not(target_os = "macos"))]
    let install_hint = "Press Ctrl+, to install";

    // Interpolated values are tag names (`psycheros-v` + semver) or
    // safe literal fallbacks — no untrusted input.
    let js = format!(
        r#"(function(){{
  var existing = document.getElementById('{TOAST_DOM_ID}');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.id = '{TOAST_DOM_ID}';
  toast.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:340px;padding:12px 16px;background:rgba(10,10,10,0.95);border:1px solid #a855f7;border-radius:8px;color:#e8e8e8;font:13px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;box-shadow:0 12px 32px -8px rgba(0,0,0,0.6);display:flex;gap:12px;align-items:flex-start';
  var content = document.createElement('div');
  content.style.flex = '1';
  var title = document.createElement('div');
  title.style.cssText = 'color:#fff;font-weight:500;margin-bottom:4px';
  title.textContent = 'Update available';
  var version = document.createElement('div');
  version.style.cssText = 'color:#888;font-family:ui-monospace,\"SF Mono\",\"IBM Plex Mono\",monospace;font-size:11px;margin-bottom:2px';
  version.textContent = '{current} → {latest}';
  var hint = document.createElement('div');
  hint.style.cssText = 'color:#888;font-size:12px';
  hint.textContent = '{install_hint}';
  content.appendChild(title);
  content.appendChild(version);
  content.appendChild(hint);
  var close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.style.cssText = 'background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0;line-height:1;flex-shrink:0';
  close.addEventListener('mouseover', function() {{ close.style.color = '#e8e8e8'; }});
  close.addEventListener('mouseout', function() {{ close.style.color = '#888'; }});
  close.addEventListener('click', function() {{ toast.remove(); }});
  toast.appendChild(content);
  toast.appendChild(close);
  if (document.body) document.body.appendChild(toast);
}})();"#,
    );

    if let Err(e) = window.eval(&js) {
        eprintln!("[launcher] toast inject eval failed: {e}");
    }
}

/// Inject a launcher-update toast. Distinct from the daemon-source toast:
/// the launcher can't self-update yet, so instead of "press to install"
/// the toast links to the GitHub releases page for manual download.
fn inject_launcher_toast(handle: &AppHandle, info: &LauncherUpdateInfo) {
    let current = &info.current_version;
    let latest = info.latest_version.as_deref().unwrap_or("(unknown)");
    let url = &info.download_url;

    let Some(window) = handle.get_webview_window("main") else {
        eprintln!("[launcher] no main window for launcher toast injection");
        return;
    };

    let js = format!(
        r#"(function(){{var existing=document.getElementById('{LAUNCHER_TOAST_DOM_ID}');if(existing)existing.remove();var toast=document.createElement('div');toast.id='{LAUNCHER_TOAST_DOM_ID}';toast.style.cssText='position:fixed;top:72px;right:16px;z-index:2147483647;max-width:340px;padding:12px 16px;background:rgba(10,10,10,0.95);border:1px solid #f59e0b;border-radius:8px;color:#e8e8e8;font:13px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;box-shadow:0 12px 32px -8px rgba(0,0,0,0.6);display:flex;gap:12px;align-items:flex-start';var content=document.createElement('div');content.style.flex='1';var title=document.createElement('div');title.style.cssText='color:#fff;font-weight:500;margin-bottom:4px';title.textContent='Launcher update available';var version=document.createElement('div');version.style.cssText='color:#888;font-family:ui-monospace,\"SF Mono\",\"IBM Plex Mono\",monospace;font-size:11px;margin-bottom:6px';version.textContent='{current} → {latest}';var link=document.createElement('a');link.href='{url}';link.target='_blank';link.rel='noopener noreferrer';link.style.cssText='color:#f59e0b;font-size:12px;text-decoration:underline;cursor:pointer';link.textContent='Download from GitHub →';content.appendChild(title);content.appendChild(version);content.appendChild(link);var close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','Dismiss');close.style.cssText='background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0;line-height:1;flex-shrink:0';close.addEventListener('mouseover',function(){{close.style.color='#e8e8e8';}});close.addEventListener('mouseout',function(){{close.style.color='#888';}});close.addEventListener('click',function(){{toast.remove();}});toast.appendChild(content);toast.appendChild(close);if(document.body)document.body.appendChild(toast);}})();"#,
    );

    if let Err(e) = window.eval(&js) {
        eprintln!("[launcher] launcher toast inject eval failed: {e}");
    }
}

/// Remove the launcher-update toast. Counterpart to `inject_launcher_toast`.
fn remove_launcher_toast(handle: &AppHandle) {
    let Some(window) = handle.get_webview_window("main") else {
        return;
    };
    let js = format!(
        "(function(){{var e=document.getElementById('{LAUNCHER_TOAST_DOM_ID}');if(e)e.remove();}})();"
    );
    if let Err(e) = window.eval(&js) {
        eprintln!("[launcher] launcher toast remove eval failed: {e}");
    }
}

/// Tear down the toast — fires when the watcher transitions from
/// "update available" back to "no update" (e.g. the user just ran the
/// update). Safe to call when no toast exists; the JS no-ops on a null
/// element.
///
/// `pub(crate)` so the apply-source-update command can call this on
/// success — otherwise the watcher's 3-hour cadence means the toast
/// would persist between "update applied" and "next watcher poll
/// confirms upstream matches local."
pub(crate) fn remove_toast(handle: &AppHandle) {
    let Some(window) = handle.get_webview_window("main") else {
        return;
    };
    let js = format!(
        "(function(){{var e=document.getElementById('{TOAST_DOM_ID}');if(e)e.remove();}})();"
    );
    if let Err(e) = window.eval(&js) {
        eprintln!("[launcher] toast remove eval failed: {e}");
    }
}
