/**
 * Manager UI logic.
 *
 * Renders the splash card based on daemon state. State comes from two
 * sources: the initial `daemon_status` invoke on page load, and live
 * `daemon-status-changed` events emitted by the Rust watcher.
 *
 * On boot, gates on `needs_first_run`: if true, hands off to first-run.js
 * for the welcome wizard + bootstrap, then resumes here when that
 * resolves.
 *
 * Renders 4-state matrix (NotInstalled / Stopped / Installed / Running)
 * with mode-aware copy (autostart vs manual). Buttons (Start/Stop) are
 * universal — autostart users can manually stop their daemon for a
 * session; it comes back at next login.
 *
 * Navigation between manager and chat is driven from Rust (see
 * src-tauri/src/daemon/navigation.rs) — this file never calls
 * window.location.replace.
 */

import { listen, safeInvoke } from "./tauri-bridge.js";
import { runFirstRun, runSourceUpdate, showCard } from "./first-run.js";
import { openDiagnostics } from "./diagnostics.js";
import { openSettings } from "./settings.js";
import { openDataCard } from "./data.js";
import { wireWarnings } from "./warnings.js";

const els = {
  body: document.body,
  panel: document.getElementById("panel"),
  title: document.getElementById("title"),
  detail: document.getElementById("detail"),
  statusText: document.getElementById("status-text"),
  actions: document.getElementById("actions"),
  meta: document.getElementById("meta"),
  error: document.getElementById("error"),
  updateBanner: document.getElementById("update-banner"),
  updateBannerVersion: document.getElementById("update-banner__version"),
  updateBannerApply: document.getElementById("update-banner__apply"),
  updateBannerLater: document.getElementById("update-banner__later"),
  logPanel: document.getElementById("log-panel"),
  logPanelBody: document.getElementById("log-panel-body"),
  logPanelClear: document.getElementById("log-panel-clear"),
  logPanelCopy: document.getElementById("log-panel-copy"),
  logPanelSave: document.getElementById("log-panel-save"),
  logPanelMore: document.getElementById("log-panel-more"),
  logSearch: document.getElementById("log-search"),
  logFilterInfo: document.getElementById("log-filter-info"),
  logFilterWarn: document.getElementById("log-filter-warn"),
  logFilterError: document.getElementById("log-filter-error"),
  actionProgress: document.getElementById("action-progress"),
  actionProgressText: document.getElementById("action-progress-text"),
};

/**
 * Show / hide the card-level action-progress banner. Loud central
 * indicator — sits above the actions list, has a spinner + pulsing
 * accent glow. Visible while any action is in flight.
 */
function showActionProgress(text) {
  if (!els.actionProgress || !els.actionProgressText) return;
  els.actionProgressText.textContent = text;
  els.actionProgress.hidden = false;
}

function hideActionProgress() {
  if (!els.actionProgress) return;
  els.actionProgress.hidden = true;
}

// Session-scoped: when the user clicks "Later", we stash the version
// they dismissed and don't re-show the banner for the same one in this
// session. Cleared on app restart so it'll reappear if still relevant.
let dismissedLatestVersion = null;

// The most recent `update-available` payload from the Rust watcher.
let lastUpdateInfo = null;

// Daemon mode (`"autostart"` or `"manual"`), fetched once on init via
// the `get_daemon_mode` command. Renders use it to swap mode-aware copy
// (e.g., the meaning of "Stop"). Defaults to `"autostart"` until the
// command resolves — matches the historical behavior.
let daemonMode = "autostart";

// Max log lines kept in the panel DOM. Older lines get evicted from the
// top to keep render cost bounded over long sessions.
const LOG_PANEL_MAX_LINES = 300;

// Live tail size for `recent_daemon_log_lines` reloads (filter/search
// reset, Load-more clicks). Starts at the same 64 KB the initial load
// uses; "Load more" doubles it up to the cap.
const LOG_TAIL_BYTES_INITIAL = 64 * 1024;
const LOG_TAIL_BYTES_MAX = 8 * 1024 * 1024;
let logCurrentTailBytes = LOG_TAIL_BYTES_INITIAL;

// Current substring search term, applied as lines come in via the live
// `daemon-log-line` event so new arrivals respect the active filter.
let logCurrentSearch = "";

// --------------------------------------------------------------------------
// Confirm modal — replaces native window.confirm (silently blocked in
// Tauri webviews).
// --------------------------------------------------------------------------

/**
 * Show a confirmation dialog and resolve with the user's choice.
 *
 * Default-focuses Cancel for safety (Enter on accident → no
 * destruction). Esc also dismisses. The backdrop is non-dismissible —
 * user must explicitly choose.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} [opts.confirmLabel="Confirm"]
 * @param {boolean} [opts.danger=false]
 * @returns {Promise<boolean>}
 */
function confirmDialog(opts) {
  const modal = document.getElementById("confirm-modal");
  const titleEl = document.getElementById("confirm-modal-title");
  const bodyEl = document.getElementById("confirm-modal-body");
  const okBtn = document.getElementById("confirm-modal-ok");
  const cancelBtn = document.getElementById("confirm-modal-cancel");

  titleEl.textContent = opts.title;
  bodyEl.textContent = opts.body;
  okBtn.textContent = opts.confirmLabel ?? "Confirm";
  okBtn.classList.toggle("danger", !!opts.danger);
  okBtn.classList.toggle("primary", !opts.danger);

  modal.hidden = false;
  // Default-focus Cancel — destructive confirms shouldn't be one-Enter away.
  cancelBtn.focus();

  return new Promise((resolve) => {
    function finish(result) {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onOk() {
      finish(true);
    }
    function onCancel() {
      finish(false);
    }
    function onKey(e) {
      if (e.key === "Escape") finish(false);
    }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

// --------------------------------------------------------------------------
// Error display
// --------------------------------------------------------------------------

function showError(message) {
  if (!els.error) return;
  els.error.textContent = String(message);
  els.error.classList.add("visible");
  const announcer = document.getElementById("launcher-error-announcer");
  if (announcer) {
    announcer.textContent = "";
    requestAnimationFrame(() => announcer.textContent = String(message));
  }
}

function clearError() {
  if (!els.error) return;
  els.error.classList.remove("visible");
  els.error.textContent = "";
  const announcer = document.getElementById("launcher-error-announcer");
  if (announcer) announcer.textContent = "";
}

// --------------------------------------------------------------------------
// Button helper
// --------------------------------------------------------------------------

/**
 * Make an action button.
 *
 * `opts.busyText` (optional) replaces the label while the click handler
 * is in flight — e.g. "Stop daemon" → "Stopping…". The `.is-busy` CSS
 * class drives a loud visual: solid accent fill, pulsing border, large
 * spinner — impossible to miss in peripheral vision.
 *
 * `opts.confirm` (optional) — a question string passed to
 * `window.confirm()` before invoking `onClick`. Native browser confirm
 * blocks synchronously, so the user can't keyboard-mash past it. Used
 * for destructive actions (Uninstall).
 *
 * While one button is busy, all OTHER buttons inside the same card
 * (not just siblings in `.actions`) are disabled. That covers the
 * banner buttons + Back-to-chat + clear-logs too, so the user
 * genuinely can't interleave actions.
 */
function makeButton(label, opts = {}) {
  const b = document.createElement("button");
  b.textContent = label;
  if (opts.primary) b.classList.add("primary");
  if (opts.danger) b.classList.add("danger");
  if (opts.disabled) b.disabled = true;

  if (opts.onClick) {
    b.addEventListener("click", async () => {
      if (opts.confirm) {
        const ok = await confirmDialog({
          title: opts.confirmTitle ?? "Are you sure?",
          body: opts.confirm,
          confirmLabel: opts.confirmLabel ??
            (opts.danger ? "Yes, proceed" : "Confirm"),
          danger: !!opts.danger,
        });
        if (!ok) return;
      }

      const original = b.textContent;
      // Scope: all buttons inside the closest .card ancestor. Wider
      // than `.actions` siblings, so the update banner + log-panel
      // controls also lock during an in-flight daemon operation.
      const card = b.closest(".card");
      const others = card
        ? Array.from(card.querySelectorAll("button")).filter((el) => el !== b)
        : [];

      b.classList.add("is-busy");
      b.disabled = true;
      if (opts.busyText) b.textContent = opts.busyText;
      others.forEach((s) => {
        if (!s.disabled) {
          s.dataset.busyDisabled = "1";
          s.disabled = true;
        }
      });
      // Loud card-level indicator. Visible regardless of where the
      // user's eyes were when they clicked.
      if (opts.busyText) showActionProgress(opts.busyText);
      clearError();

      try {
        await opts.onClick();
      } catch (err) {
        showError(err);
      } finally {
        hideActionProgress();
        // If the click handler called render() (which replaces the
        // actions group), this button is detached. Skip the restore
        // for detached nodes — the new buttons reflect the new state.
        if (b.isConnected) {
          b.classList.remove("is-busy");
          b.disabled = false;
          if (opts.busyText) b.textContent = original;
        }
        others.forEach((s) => {
          if (s.dataset.busyDisabled === "1") {
            delete s.dataset.busyDisabled;
            if (s.isConnected) s.disabled = false;
          }
        });
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

  // The log panel is hidden only when the daemon was never installed —
  // no log file exists yet. All other states have either current or
  // historical output worth surfacing.
  if (els.logPanel) {
    els.logPanel.hidden = state === "not-installed";
  }

  switch (state) {
    case "running":
      els.title.textContent = "Psycheros is running.";
      els.detail.innerHTML = renderRunningDetail(port);
      setActions([
        makeButton("Back to chat", {
          primary: true,
          onClick: async () => {
            const { err } = await safeInvoke("set_view_mode", { mode: "chat" });
            if (err) throw new Error(err);
          },
        }),
        makeButton("Stop daemon", {
          busyText: "Stopping…",
          onClick: async () => {
            const { ok, err } = await safeInvoke("stop_daemon");
            if (err) throw new Error(err);
            render(ok);
          },
        }),
        makeButton("Uninstall", {
          danger: true,
          busyText: "Uninstalling…",
          confirmTitle: "Uninstall Psycheros?",
          confirmLabel: "Uninstall",
          confirm:
            "This removes the OS service definition so Psycheros won't run " +
            "automatically anymore.\n\n" +
            "Your entity's memories, identity, and vault stay untouched — " +
            "only the service registration is removed. You can reinstall " +
            "any time from this manager.",
          onClick: async () => {
            const { ok, err } = await safeInvoke("uninstall_autostart");
            if (err) throw new Error(err);
            render(ok);
          },
        }),
      ]);
      break;

    case "stopped":
      els.title.textContent = "Daemon is stopped.";
      els.detail.innerHTML = renderStoppedDetail();
      setActions([
        makeButton("Start daemon", {
          primary: true,
          busyText: "Starting…",
          onClick: async () => {
            const { ok, err } = await safeInvoke("start_daemon");
            if (err) throw new Error(err);
            render(ok);
          },
        }),
        makeButton("Uninstall", {
          danger: true,
          busyText: "Uninstalling…",
          confirmTitle: "Uninstall Psycheros?",
          confirmLabel: "Uninstall",
          confirm:
            "This removes the OS service definition so Psycheros won't run " +
            "automatically anymore.\n\n" +
            "Your entity's memories, identity, and vault stay untouched — " +
            "only the service registration is removed. You can reinstall " +
            "any time from this manager.",
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
        `The OS supervisor has loaded the service. It should bind <code>:${port}</code> within a few seconds; the launcher will switch to chat automatically when it does. If this state persists, the daemon may be crash-looping — check the log panel below.`;
      setActions([
        makeButton("Stop daemon", {
          busyText: "Stopping…",
          onClick: async () => {
            const { ok, err } = await safeInvoke("stop_daemon");
            if (err) throw new Error(err);
            render(ok);
          },
        }),
        makeButton("Uninstall", {
          danger: true,
          busyText: "Uninstalling…",
          confirmTitle: "Uninstall Psycheros?",
          confirmLabel: "Uninstall",
          confirm:
            "This removes the OS service definition so Psycheros won't run " +
            "automatically anymore.\n\n" +
            "Your entity's memories, identity, and vault stay untouched — " +
            "only the service registration is removed. You can reinstall " +
            "any time from this manager.",
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
        "Two options. <strong>Autostart</strong> runs me at every login and " +
        "auto-restarts on crash — best if you want me always available. " +
        "<strong>Manual</strong> loads me but doesn't run at login — best " +
        "if you'd rather start and stop me yourself.";
      setActions([
        makeButton("Install autostart", {
          primary: true,
          busyText: "Installing autostart…",
          onClick: async () => {
            const { ok, err } = await safeInvoke("install_autostart");
            if (err) throw new Error(err);
            daemonMode = "autostart";
            render(ok);
          },
        }),
        makeButton("Install for manual start/stop", {
          busyText: "Installing…",
          onClick: async () => {
            const { ok, err } = await safeInvoke("install_manual");
            if (err) throw new Error(err);
            daemonMode = "manual";
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

function renderRunningDetail(port) {
  const base =
    `Serving on <code>localhost:${port}</code> and supervised by the OS — ` +
    `closing this app doesn't stop me.`;
  if (daemonMode === "autostart") {
    return `${base} <em>(Autostart: I'll come back at every login. Stop is a session-scoped pause.)</em>`;
  }
  return `${base} <em>(Manual mode: I'll stay stopped until you start me again.)</em>`;
}

function renderStoppedDetail() {
  if (daemonMode === "autostart") {
    return "I'm stopped for this session. I'll come back at next login " +
      "automatically — or click Start daemon to bring me back now.";
  }
  return "I'm stopped. Click Start daemon to bring me back, or Uninstall " +
    "if you don't want me supervised by the OS anymore.";
}

function statusLabel(state, port) {
  switch (state) {
    case "running":
      return `daemon running on :${port}`;
    case "installed":
      return `installed; waiting for :${port}`;
    case "stopped":
      return "daemon stopped";
    case "not-installed":
      return "daemon not installed";
    default:
      return "unknown";
  }
}

// --------------------------------------------------------------------------
// Update banner (driven by Rust's background update watcher)
// --------------------------------------------------------------------------

function applyUpdateInfo(info) {
  if (!info || !els.updateBanner) return;
  lastUpdateInfo = info;

  const shouldShow = info.update_available &&
    info.latest_version !== dismissedLatestVersion;

  if (!shouldShow) {
    els.updateBanner.hidden = true;
    return;
  }

  const current = info.current_version ?? "(unknown)";
  const latest = info.latest_version ?? "(unknown)";
  els.updateBannerVersion.textContent = `${current} → ${latest}`;
  els.updateBanner.hidden = false;
}

function wireUpdateBanner() {
  if (!els.updateBannerApply || !els.updateBannerLater) return;

  els.updateBannerApply.addEventListener("click", async () => {
    // Take down the floating toast immediately — the user has already
    // taken action, so the "press ⌘, to install" hint is stale.
    document.getElementById("psycheros-update-toast")?.remove();

    els.updateBannerApply.disabled = true;
    try {
      await runSourceUpdate();
      showCard("card-manager");
      // Poll daemon_status until it reports Running (or we give up).
      // See manager.js commit history — the watcher emits only on
      // state transitions, and a fast restart can be invisible to it,
      // so a single post-update call is racy with daemon rebinding.
      const POLL_MS = 1000;
      const MAX_POLLS = 30;
      for (let i = 0; i < MAX_POLLS; i++) {
        const { ok } = await safeInvoke("daemon_status");
        if (ok) render(ok);
        if (ok?.state === "running") break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } finally {
      els.updateBannerApply.disabled = false;
    }
  });

  els.updateBannerLater.addEventListener("click", () => {
    if (lastUpdateInfo?.latest_version) {
      dismissedLatestVersion = lastUpdateInfo.latest_version;
    }
    els.updateBanner.hidden = true;
  });
}

// --------------------------------------------------------------------------
// Daemon log panel
// --------------------------------------------------------------------------

/**
 * Append a single log line to the panel. Classifies INFO/WARN/ERROR by
 * substring match on the psycheros logger's `[LEVEL]` prefix — good
 * enough to draw the eye without parsing structure.
 */
/**
 * Classify a log line into "info" / "warn" / "error" by substring match
 * on the psycheros logger's `[LEVEL]` prefix. Heuristic — good enough
 * to draw the eye without parsing structure.
 */
function classifyLogLine(line) {
  if (line.includes("[ERROR]") || line.startsWith("error:")) return "error";
  if (line.includes("[WARN ]") || line.includes("[WARN]")) return "warn";
  return "info";
}

/**
 * Apply the active search filter to a single line element. Visible iff
 * the line text contains the current search substring (case-insensitive,
 * empty search matches everything). Level-filter state composes via
 * CSS (`.log-panel__body[data-hide-*]`) — JS only controls the search
 * dimension.
 */
function applySearchToLine(div, line) {
  if (!logCurrentSearch) {
    div.style.removeProperty("display");
    return;
  }
  if (line.toLowerCase().includes(logCurrentSearch)) {
    div.style.removeProperty("display");
  } else {
    div.style.display = "none";
  }
}

function appendLogLine(line) {
  if (!els.logPanelBody) return;
  const div = document.createElement("div");
  div.className = "line";
  const level = classifyLogLine(line);
  if (level === "error") div.classList.add("is-error");
  else if (level === "warn") div.classList.add("is-warn");

  div.textContent = line;
  div.dataset.text = line;
  applySearchToLine(div, line);
  els.logPanelBody.appendChild(div);

  while (els.logPanelBody.childElementCount > LOG_PANEL_MAX_LINES) {
    els.logPanelBody.firstElementChild?.remove();
  }
  // Auto-scroll only when user is at (or near) the bottom — avoids
  // hijacking when they've scrolled up to read older lines.
  const nearBottom =
    els.logPanelBody.scrollHeight - els.logPanelBody.scrollTop -
        els.logPanelBody.clientHeight < 40;
  if (nearBottom) {
    els.logPanelBody.scrollTop = els.logPanelBody.scrollHeight;
  }
}

/**
 * Snapshot the currently-visible log lines (after filter + search) as a
 * single newline-joined string. Used by Copy and Save.
 */
function visibleLogText() {
  if (!els.logPanelBody) return "";
  const lines = [];
  for (const div of els.logPanelBody.children) {
    // offsetParent is null when display:none — robust check covering
    // both the search filter (inline style) and the level-filter
    // CSS rules.
    if (div.offsetParent !== null) {
      lines.push(div.dataset.text ?? div.textContent ?? "");
    }
  }
  return lines.join("\n");
}

/**
 * Briefly swap a button's label to indicate completion (e.g., Copied).
 * Restores the original label after `delay` ms.
 */
function flashButton(btn, swappedLabel, delay = 1200) {
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = swappedLabel;
  setTimeout(() => {
    if (btn.isConnected) btn.textContent = original;
  }, delay);
}

function syncFilterAttributes() {
  if (!els.logPanelBody) return;
  const body = els.logPanelBody;
  body.toggleAttribute("data-hide-info", els.logFilterInfo?.checked === false);
  body.toggleAttribute("data-hide-warn", els.logFilterWarn?.checked === false);
  body.toggleAttribute(
    "data-hide-error",
    els.logFilterError?.checked === false,
  );
}

function applySearchToAllLines() {
  if (!els.logPanelBody) return;
  for (const div of els.logPanelBody.children) {
    applySearchToLine(div, div.dataset.text ?? div.textContent ?? "");
  }
}

async function fetchAndRenderHistory(tailBytes) {
  const { ok } = await safeInvoke("recent_daemon_log_lines", {
    maxLines: LOG_PANEL_MAX_LINES,
    tailBytes,
  });
  if (!ok || !Array.isArray(ok)) return;
  els.logPanelBody?.replaceChildren();
  for (const line of ok) appendLogLine(line);
}

function wireLogPanel() {
  // Filter checkboxes — pure CSS toggling via data-hide-* attributes.
  for (
    const cb of [els.logFilterInfo, els.logFilterWarn, els.logFilterError]
  ) {
    cb?.addEventListener("change", syncFilterAttributes);
  }
  syncFilterAttributes();

  // Substring search — case-insensitive, applied to existing lines on
  // input + to each new arrival in appendLogLine.
  els.logSearch?.addEventListener("input", () => {
    logCurrentSearch = els.logSearch.value.trim().toLowerCase();
    applySearchToAllLines();
  });

  // Clear — wipes the view (the underlying log file is untouched).
  els.logPanelClear?.addEventListener("click", () => {
    els.logPanelBody?.replaceChildren();
  });

  // Copy — visible lines only, joined by newlines, via the async
  // clipboard API. Silent fallback on older WebViews.
  els.logPanelCopy?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(visibleLogText());
      flashButton(els.logPanelCopy, "Copied");
    } catch (err) {
      console.warn("[launcher] clipboard.writeText failed:", err);
      flashButton(els.logPanelCopy, "Failed");
    }
  });

  // Save — visible lines only, downloaded as a timestamped .log file
  // via a Blob URL. Works in Tauri 2 webviews without extra Rust glue.
  els.logPanelSave?.addEventListener("click", () => {
    const blob = new Blob([visibleLogText()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `psycheros-daemon-${ts}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // Load more — re-read with a doubled tail size. Capped at
  // LOG_TAIL_BYTES_MAX. Re-fetch replaces panel content; the live tail
  // (daemon-log-line events) continues appending on top.
  els.logPanelMore?.addEventListener("click", async () => {
    if (logCurrentTailBytes >= LOG_TAIL_BYTES_MAX) return;
    logCurrentTailBytes = Math.min(logCurrentTailBytes * 2, LOG_TAIL_BYTES_MAX);
    els.logPanelMore.disabled = true;
    try {
      await fetchAndRenderHistory(logCurrentTailBytes);
      flashButton(
        els.logPanelMore,
        `Loaded ${(logCurrentTailBytes / 1024).toFixed(0)} KB`,
      );
    } finally {
      // Re-enable only if we still have room to grow.
      if (logCurrentTailBytes < LOG_TAIL_BYTES_MAX) {
        els.logPanelMore.disabled = false;
      } else {
        els.logPanelMore.title = "Already showing the maximum tail size";
      }
    }
  });
}

// --------------------------------------------------------------------------
// Manager card meta footer — keyboard hint + tools row
// --------------------------------------------------------------------------

/**
 * Render the footer at the bottom of the manager card: the ⌘, hint
 * and a "Diagnostics" button that opens the diagnostics sub-card.
 *
 * Always rendered once on init — no state-conditional variants. The
 * diagnostics surface itself handles "daemon not installed" gracefully,
 * so it's safe to expose even pre-install.
 */
function renderMeta() {
  els.meta.replaceChildren();

  const hint = document.createElement("div");
  hint.innerHTML =
    `Press <kbd>⌘,</kbd> to toggle between this manager and chat at any time.`;
  els.meta.appendChild(hint);

  const tools = document.createElement("div");
  tools.className = "meta__tools";

  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "meta__tool";
  settingsBtn.textContent = "Settings";
  settingsBtn.addEventListener("click", () => {
    openSettings(() => showCard("card-manager"));
  });
  tools.appendChild(settingsBtn);

  const dataBtn = document.createElement("button");
  dataBtn.type = "button";
  dataBtn.className = "meta__tool";
  dataBtn.textContent = "Data";
  dataBtn.addEventListener("click", () => {
    openDataCard(() => showCard("card-manager"));
  });
  tools.appendChild(dataBtn);

  const diagBtn = document.createElement("button");
  diagBtn.type = "button";
  diagBtn.className = "meta__tool";
  diagBtn.textContent = "Diagnostics";
  diagBtn.addEventListener("click", () => {
    openDiagnostics(() => showCard("card-manager"));
  });
  tools.appendChild(diagBtn);

  els.meta.appendChild(tools);
}

async function populateInitialLogs() {
  await fetchAndRenderHistory(logCurrentTailBytes);
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

(async function init() {
  // Gate on first-run. In dev (PSYCHEROS_SRC_DIR set), Rust returns false
  // here so devs running from a clone skip the wizard entirely.
  const needsCheck = await safeInvoke("needs_first_run");
  if (needsCheck.err) {
    console.error("[launcher] needs_first_run failed:", needsCheck.err);
  } else if (needsCheck.ok) {
    await runFirstRun();
  }

  showCard("card-manager");
  wireUpdateBanner();
  wireLogPanel();

  // Persisted mode (autostart/manual) drives mode-aware copy in render().
  const modeResult = await safeInvoke("get_daemon_mode");
  if (modeResult.ok) daemonMode = modeResult.ok;

  renderMeta();

  const { ok, err } = await safeInvoke("daemon_status");
  if (err) {
    els.title.textContent = "daemon_status call failed";
    showError(err);
    return;
  }
  render(ok);

  // Self-repair warnings (MCP-down, crashloop, port-conflict).
  // Wires its own listeners on daemon-log-line + daemon-status-changed
  // — see frontend/js/warnings.js.
  wireWarnings(ok);

  // Live daemon-status updates from the Rust watcher.
  await listen("daemon-status-changed", (evt) => render(evt.payload));

  // Source-update detection.
  await listen("update-available", (evt) => applyUpdateInfo(evt.payload));

  // Daemon log tail. Populate from history, then stream live lines.
  await populateInitialLogs();
  await listen("daemon-log-line", (evt) => {
    if (typeof evt.payload === "string") appendLogLine(evt.payload);
  });

  // Fresh update check covers the "watcher emitted into chat-view, no
  // listener heard it" race.
  safeInvoke("check_for_updates").then(({ ok }) => {
    if (ok) applyUpdateInfo(ok);
  });
})();
