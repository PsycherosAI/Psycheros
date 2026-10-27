/**
 * Data management card.
 *
 * Four actions, each behind a confirm step:
 *   - Back up: POST /api/admin/entity-data/export, save zip to
 *     Downloads. Daemon must be Running. (Simple confirm.)
 *   - Restore: tauri-plugin-dialog file picker → restore_data with the
 *     path. Daemon must be Running. Restart happens server-side.
 *     (Simple confirm.)
 *   - Wipe: typed-confirm "WIPE". Clears entity data dir; identity is
 *     re-templated on next daemon boot.
 *   - Re-init: typed-confirm "REINIT". Uninstalls service, deletes
 *     source clone + identity dir, clears bundled_source_version so
 *     next launch returns the user to the first-run wizard.
 *
 * Returns the user to the manager card via the onBack closure.
 */

import { safeInvoke } from "./tauri-bridge.js";
import { showCard } from "./first-run.js";

const els = {
  body: () => document.getElementById("data-actions"),
  error: () => document.getElementById("data-error"),
  progress: () => document.getElementById("data-progress"),
  progressText: () => document.getElementById("data-progress-text"),
  back: () => document.getElementById("data-back"),
  backup: () => document.getElementById("data-backup"),
  restore: () => document.getElementById("data-restore"),
  wipe: () => document.getElementById("data-wipe"),
  reinit: () => document.getElementById("data-reinit"),
};

function showError(message) {
  const e = els.error();
  if (!e) return;
  e.textContent = String(message);
  e.classList.add("visible");
}

function clearError() {
  const e = els.error();
  if (!e) return;
  e.classList.remove("visible");
  e.textContent = "";
}

function showProgress(text) {
  els.progressText().textContent = text;
  els.progress().hidden = false;
}

function hideProgress() {
  els.progress().hidden = true;
}

/**
 * Disable every action button while one is running, so the user can't
 * race wipe with backup, etc. Returns a re-enable closure.
 */
function lockButtons() {
  const buttons = [
    els.backup(),
    els.restore(),
    els.wipe(),
    els.reinit(),
    els.back(),
  ];
  for (const b of buttons) {
    if (b) b.disabled = true;
  }
  return () => {
    for (const b of buttons) {
      if (b) b.disabled = false;
    }
  };
}

// --------------------------------------------------------------------------
// Simple confirm — reuses the manager's confirm modal
// --------------------------------------------------------------------------

function simpleConfirm(opts) {
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
  cancelBtn.focus();

  return new Promise((resolve) => {
    function finish(result) {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

// --------------------------------------------------------------------------
// Typed-confirm — speed bump for destructive operations
// --------------------------------------------------------------------------

/**
 * Show a typed-confirm modal. The user must type the exact phrase
 * into the input before the confirm button activates. Esc cancels.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} opts.phrase — the literal string the user types
 * @param {string} [opts.confirmLabel="Proceed"]
 * @returns {Promise<boolean>}
 */
function typedConfirm(opts) {
  const modal = document.getElementById("typed-confirm-modal");
  const titleEl = document.getElementById("typed-confirm-modal-title");
  const bodyEl = document.getElementById("typed-confirm-modal-body");
  const phraseEl = document.getElementById("typed-confirm-modal-phrase");
  const inputEl = document.getElementById("typed-confirm-modal-input");
  const okBtn = document.getElementById("typed-confirm-modal-ok");
  const cancelBtn = document.getElementById("typed-confirm-modal-cancel");

  titleEl.textContent = opts.title;
  bodyEl.textContent = opts.body;
  phraseEl.textContent = opts.phrase;
  okBtn.textContent = opts.confirmLabel ?? "Proceed";
  inputEl.value = "";
  okBtn.disabled = true;

  modal.hidden = false;
  inputEl.focus();

  return new Promise((resolve) => {
    function finish(result) {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      inputEl.removeEventListener("input", onInput);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onInput = () => {
      okBtn.disabled = inputEl.value !== opts.phrase;
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    inputEl.addEventListener("input", onInput);
    document.addEventListener("keydown", onKey);
  });
}

// --------------------------------------------------------------------------
// Action handlers
// --------------------------------------------------------------------------

async function runBackup() {
  clearError();
  const ok = await simpleConfirm({
    title: "Back up entity data?",
    body: "I'll ask the daemon to bundle my current memories, identity, " +
      "vault, and settings into a zip and drop it in your Downloads " +
      "folder. The operation can take a few seconds on a large entity.",
    confirmLabel: "Back up now",
  });
  if (!ok) return;

  const unlock = lockButtons();
  showProgress("Exporting entity data…");
  try {
    const { ok: result, err } = await safeInvoke("backup_data");
    if (err) throw new Error(err);
    // A partial backup is a real zip, but it's missing the entity-core
    // side (identity, memories, knowledge graph) — say so plainly
    // instead of letting it look complete.
    const partialNote = result.partial
      ? " — ⚠ PARTIAL: entity-core wasn't reachable; identity/memories/graph NOT included"
      : "";
    showProgress(
      `Saved ${humanBytes(result.size_bytes)} → ${result.path}${partialNote}`,
    );
    // Leave the progress banner up so the user can see where the file
    // landed. They can dismiss by clicking back.
  } catch (err) {
    showError(err.message ?? err);
    hideProgress();
  } finally {
    unlock();
  }
}

async function runRestore() {
  clearError();

  // Use Tauri's native dialog plugin via withGlobalTauri (loaded as
  // window.__TAURI__.dialog.open). Path-based so we can handle large
  // zips without IPC bloat.
  const dialog = window.__TAURI__?.dialog;
  if (!dialog?.open) {
    showError(
      "File picker isn't available — the dialog plugin failed to load.",
    );
    return;
  }
  const picked = await dialog.open({
    multiple: false,
    directory: false,
    filters: [{ name: "Psycheros backup (.zip)", extensions: ["zip"] }],
  });
  if (!picked) return; // user cancelled
  const path = String(picked);

  const ok = await simpleConfirm({
    title: "Restore from this backup?",
    body: `This replaces my current data with the contents of ${path}. ` +
      "Your current memories, identity, vault, and settings will be " +
      "overwritten. I'll restart automatically when the import finishes.",
    confirmLabel: "Restore",
    danger: true,
  });
  if (!ok) return;

  const unlock = lockButtons();
  showProgress("Importing entity data…");
  try {
    const { ok: result, err } = await safeInvoke("restore_data", { path });
    if (err) throw new Error(err);
    if (!result.success) throw new Error(result.result_message);
    showProgress(result.result_message);
  } catch (err) {
    showError(err.message ?? err);
    hideProgress();
  } finally {
    unlock();
  }
}

async function runWipe() {
  clearError();
  const ok = await typedConfirm({
    title: "Wipe my entity data?",
    body: "Clears my memories, identity files, vault docs, and database. " +
      "The OS service registration stays — first-run will template fresh " +
      "identity files on next launch. This cannot be undone unless you " +
      "have a backup zip.",
    phrase: "WIPE",
    confirmLabel: "Wipe everything",
  });
  if (!ok) return;

  const unlock = lockButtons();
  showProgress("Wiping entity data…");
  try {
    const { err } = await safeInvoke("wipe_entity_data");
    if (err) throw new Error(err);
    showProgress(
      "Wipe complete. Restart the daemon or relaunch to bootstrap fresh identity files.",
    );
  } catch (err) {
    showError(err.message ?? err);
    hideProgress();
  } finally {
    unlock();
  }
}

async function runReinit() {
  clearError();
  const ok = await typedConfirm({
    title: "Re-initialize Psycheros?",
    body: "I'll stop the daemon, uninstall the OS service, delete my source " +
      "clone and identity directory, and clear the installed-version " +
      "marker. You'll go through the first-run wizard again next launch. " +
      "Memories and vault content survive — only identity is reset.",
    phrase: "REINIT",
    confirmLabel: "Re-initialize",
  });
  if (!ok) return;

  const unlock = lockButtons();
  showProgress("Re-initializing…");
  try {
    const { err } = await safeInvoke("reinit_psycheros");
    if (err) throw new Error(err);
    showProgress(
      "Re-init complete. Quit and relaunch Psycheros to run through " +
        "the first-run wizard.",
    );
  } catch (err) {
    showError(err.message ?? err);
    hideProgress();
  } finally {
    unlock();
  }
}

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------

function humanBytes(n) {
  if (n == null) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// --------------------------------------------------------------------------
// Public entry
// --------------------------------------------------------------------------

let wired = false;

export function openDataCard(onBack) {
  showCard("card-data");
  clearError();
  hideProgress();

  if (!wired) {
    wired = true;
    els.backup()?.addEventListener("click", runBackup);
    els.restore()?.addEventListener("click", runRestore);
    els.wipe()?.addEventListener("click", runWipe);
    els.reinit()?.addEventListener("click", runReinit);
  }

  const back = els.back();
  if (back) {
    const handler = () => {
      back.removeEventListener("click", handler);
      onBack?.();
    };
    back.addEventListener("click", handler);
  }
}
