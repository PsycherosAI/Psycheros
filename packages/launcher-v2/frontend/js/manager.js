/**
 * Manager UI logic.
 *
 * Renders the splash card based on daemon state. State comes from two
 * sources: the initial `daemon_status` invoke on page load, and live
 * `daemon-status-changed` events emitted by the Rust watcher.
 *
 * Navigation between manager and chat is driven from Rust (see
 * src-tauri/src/daemon/navigation.rs) — this file never calls
 * window.location.replace.
 */

import { listen, safeInvoke } from "./tauri-bridge.js";

const els = {
  body: document.body,
  panel: document.getElementById("panel"),
  title: document.getElementById("title"),
  detail: document.getElementById("detail"),
  statusText: document.getElementById("status-text"),
  actions: document.getElementById("actions"),
  meta: document.getElementById("meta"),
  error: document.getElementById("error"),
};

// --------------------------------------------------------------------------
// Error display
// --------------------------------------------------------------------------

function showError(message) {
  if (!els.error) return;
  els.error.textContent = String(message);
  els.error.classList.add("visible");
}

function clearError() {
  if (!els.error) return;
  els.error.classList.remove("visible");
  els.error.textContent = "";
}

// --------------------------------------------------------------------------
// Button helper
// --------------------------------------------------------------------------

function makeButton(label, opts = {}) {
  const b = document.createElement("button");
  b.textContent = label;
  if (opts.primary) b.classList.add("primary");
  if (opts.danger) b.classList.add("danger");
  if (opts.disabled) b.disabled = true;

  if (opts.onClick) {
    b.addEventListener("click", async () => {
      b.disabled = true;
      clearError();
      try {
        await opts.onClick();
      } catch (err) {
        showError(err);
      } finally {
        b.disabled = false;
      }
    });
  }

  return b;
}

function setActions(buttons) {
  els.actions.replaceChildren(...buttons);
}

// --------------------------------------------------------------------------
// State-conditional rendering
// --------------------------------------------------------------------------

function render(status) {
  if (!status) return;
  const { state, port } = status;
  els.body.dataset.state = state;
  els.statusText.textContent = statusLabel(state, port);

  switch (state) {
    case "running":
      els.title.textContent = "Psycheros is running.";
      els.detail.innerHTML =
        `The daemon is serving on <code>localhost:${port}</code> and is supervised by the OS — it stays running even after this app is closed.`;
      setActions([
        makeButton("Back to chat", {
          primary: true,
          onClick: async () => {
            const { err } = await safeInvoke("set_view_mode", { mode: "chat" });
            if (err) throw new Error(err);
          },
        }),
        makeButton("Uninstall autostart", {
          danger: true,
          onClick: async () => {
            const { ok, err } = await safeInvoke("uninstall_autostart");
            if (err) throw new Error(err);
            render(ok);
          },
        }),
      ]);
      break;

    case "installed":
      els.title.textContent = "Daemon is starting…";
      els.detail.innerHTML =
        `The OS supervisor has loaded the service. It should bind <code>:${port}</code> within a few seconds; the launcher will switch to chat automatically when it does. If this state persists, the daemon may be crash-looping — check the logs.`;
      setActions([
        makeButton("Uninstall autostart", {
          danger: true,
          onClick: async () => {
            const { ok, err } = await safeInvoke("uninstall_autostart");
            if (err) throw new Error(err);
            render(ok);
          },
        }),
      ]);
      break;

    case "not-installed":
      els.title.textContent = "Psycheros isn't installed yet.";
      els.detail.innerHTML =
        "Install autostart to run Psycheros as a persistent OS service. It will start at every login and restart itself if it ever crashes.";
      setActions([
        makeButton("Install autostart", {
          primary: true,
          onClick: async () => {
            const { ok, err } = await safeInvoke("install_autostart");
            if (err) throw new Error(err);
            render(ok);
          },
        }),
      ]);
      break;

    default:
      els.title.textContent = "Unknown state";
      els.detail.textContent = JSON.stringify(status);
  }
}

function statusLabel(state, port) {
  switch (state) {
    case "running":
      return `daemon running on :${port}`;
    case "installed":
      return `installed; waiting for :${port}`;
    case "not-installed":
      return "daemon not installed";
    default:
      return "unknown";
  }
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

(async function init() {
  els.meta.innerHTML =
    `<div>Press <kbd>⌘,</kbd> to toggle between this manager and chat at any time.</div>`;

  const { ok, err } = await safeInvoke("daemon_status");
  if (err) {
    els.title.textContent = "daemon_status call failed";
    showError(err);
    return;
  }
  render(ok);

  // Live updates from the Rust watcher.
  await listen("daemon-status-changed", (evt) => render(evt.payload));
})();
