/**
 * First-run wizard + bootstrap progress.
 *
 * Driven from manager.js init() — if `needs_first_run` returns true, the
 * wizard is shown; on submit, save_initial_config persists the user's
 * inputs and `first_run` does the heavy work (extract → stage Deno →
 * warm Deno cache), emitting `first-run-progress` events the whole time.
 *
 * `runFirstRun()` resolves once the user has reached the end of the
 * flow — i.e. config + bundled_source_version are on disk — so manager.js
 * can fall through to its normal render.
 */

import { listen, safeInvoke } from "./tauri-bridge.js";

const PHASE_LABELS = {
  "clone": "Fetching my source code…",
  "stage-deno": "Setting up my runtime…",
  "warm-cache": "Loading my dependencies…",
};

const PHASE_DETAILS = {
  "clone": "Downloading from GitHub. This only happens once.",
  "stage-deno": "Almost there.",
  // Warm-cache is the slow one — set expectations so it doesn't look hung.
  "warm-cache": "Some downloads can be slow over a fresh connection.",
};

const TICKER_MAX_LINES = 80;

const els = {
  wizardCard: () => document.getElementById("card-wizard"),
  wizardForm: () => document.getElementById("wizard-form"),
  wizardError: () => document.getElementById("wizard-error"),
  bootstrapCard: () => document.getElementById("card-bootstrap"),
  bootstrapTitle: () => document.getElementById("bootstrap-title"),
  bootstrapDetail: () => document.getElementById("bootstrap-detail"),
  bootstrapTicker: () => document.getElementById("bootstrap-ticker"),
  bootstrapError: () => document.getElementById("bootstrap-error"),
  bootstrapActions: () => document.getElementById("bootstrap-actions"),
};

function showCard(id) {
  for (
    const c of [
      "card-wizard",
      "card-bootstrap",
      "card-manager",
      "card-diagnostics",
      "card-settings",
      "card-data",
    ]
  ) {
    const el = document.getElementById(c);
    if (el) el.hidden = c !== id;
  }
}

function showError(target, message) {
  if (!target) return;
  target.textContent = String(message);
  target.classList.add("visible");
}

function clearError(target) {
  if (!target) return;
  target.classList.remove("visible");
  target.textContent = "";
}

function appendTicker(line) {
  const ticker = els.bootstrapTicker();
  if (!ticker) return;
  const div = document.createElement("div");
  div.className = "line";
  div.textContent = line;
  ticker.appendChild(div);

  // Cap the rendered history so the DOM doesn't grow unbounded during a
  // long cache-warm (could be thousands of Download lines).
  while (ticker.childElementCount > TICKER_MAX_LINES) {
    ticker.firstElementChild?.remove();
  }
  ticker.scrollTop = ticker.scrollHeight;
}

function resetTicker() {
  const ticker = els.bootstrapTicker();
  if (ticker) ticker.replaceChildren();
}

// --------------------------------------------------------------------------
// Wizard form
// --------------------------------------------------------------------------

function browserDefaultTimezone() {
  // `Intl.DateTimeFormat().resolvedOptions().timeZone` is widely supported
  // and returns an IANA zone like "America/New_York". Fall back to UTC if
  // the runtime can't resolve one (rare; older WebViews).
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Populate the wizard form with sensible starting values. When
 * general-settings.json already exists (e.g. user wiped data and is
 * reinstalling but didn't wipe the file), pre-fill from those values so
 * they don't have to retype. Otherwise: defaults from the HTML inputs
 * plus the browser's detected timezone.
 *
 * Async because the read goes through Tauri IPC. Failure to read is
 * non-fatal — fall through to defaults and let the user re-enter.
 */
async function prefillWizard() {
  const { ok: existing, err } = await safeInvoke("read_general_settings");
  if (err) {
    // Malformed JSON or unreadable file — fall through to defaults rather
    // than blocking the user out of the wizard. Log for the support path.
    console.warn("[launcher] read_general_settings failed:", err);
  }

  if (existing) {
    const entityInput = document.getElementById("wf-entity");
    const userInput = document.getElementById("wf-user");
    if (entityInput && typeof existing.entityName === "string") {
      entityInput.value = existing.entityName;
    }
    if (userInput && typeof existing.userName === "string") {
      userInput.value = existing.userName;
    }
    populateTimezoneSelect(existing.timezone);
  } else {
    populateTimezoneSelect();
  }
}

/**
 * Populate the timezone <select> with the IANA list.
 *
 * @param {string=} preferredTz — pre-select this zone if provided
 *   (e.g. from a prior general-settings.json). Falls back to the browser's
 *   detected zone when omitted or when the preferred zone isn't a valid
 *   IANA identifier the runtime recognizes.
 */
function populateTimezoneSelect(preferredTz) {
  const select = document.getElementById("wf-tz");
  if (!select) return;

  const detected = preferredTz || browserDefaultTimezone();

  // `Intl.supportedValuesOf('timeZone')` returns the full IANA list (~400
  // entries). Available in WKWebView from Safari 15.4 / macOS 12.3+. The
  // launcher's minimumSystemVersion is 12.0, so we may hit a runtime
  // without it — fall back to a short curated list in that case. Native
  // <select> supports type-to-jump, so 400 entries is fine UX.
  const zones = (typeof Intl.supportedValuesOf === "function")
    ? Intl.supportedValuesOf("timeZone")
    : FALLBACK_TIMEZONES;

  // Ensure the detected zone is always in the list (in case it's not in
  // the fallback set, or the runtime returns an unusually-trimmed list).
  const all = zones.includes(detected) ? zones : [detected, ...zones];

  select.replaceChildren(
    ...all.map((z) => {
      const opt = document.createElement("option");
      opt.value = z;
      opt.textContent = z;
      if (z === detected) opt.selected = true;
      return opt;
    }),
  );
}

// Short curated fallback for the (rare) case where the WebView is too old
// to expose `Intl.supportedValuesOf`. Just the common zones — anyone with
// a need for a less-common zone can update once first-run is done, via
// the future settings panel (or by editing config.json directly).
const FALLBACK_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Perth",
  "Pacific/Auckland",
];

function readWizardInputs() {
  // Tauri 2 auto-converts Rust snake_case command parameters to camelCase
  // on the JS side. The Rust signature is `entity_name: String, …` so JS
  // must send `entityName` etc., not the snake_case form.
  const form = els.wizardForm();
  const data = new FormData(form);
  return {
    entityName: (data.get("entity_name") || "").toString().trim() ||
      "Assistant",
    userName: (data.get("user_name") || "").toString().trim() || "You",
    timezone: (data.get("timezone") || "").toString().trim() || "UTC",
  };
}

function awaitWizardSubmit() {
  return new Promise((resolve) => {
    const form = els.wizardForm();
    const handler = (e) => {
      e.preventDefault();
      form.removeEventListener("submit", handler);
      resolve(readWizardInputs());
    };
    form.addEventListener("submit", handler);
  });
}

// --------------------------------------------------------------------------
// Bootstrap (extract / stage / warm)
// --------------------------------------------------------------------------

async function runBootstrap() {
  resetTicker();
  clearError(els.bootstrapError());
  els.bootstrapActions().replaceChildren();

  const unlisten = await listen("first-run-progress", (evt) => {
    const payload = evt.payload || {};
    switch (payload.kind) {
      case "phase": {
        const label = PHASE_LABELS[payload.phase] ?? `Phase: ${payload.phase}`;
        const detail = PHASE_DETAILS[payload.phase] ?? "";
        els.bootstrapTitle().textContent = label;
        els.bootstrapDetail().textContent = detail;
        appendTicker(`── ${label} ──`);
        break;
      }
      case "line":
        appendTicker(payload.line ?? "");
        break;
      case "done":
        appendTicker("── Done ──");
        break;
      default:
        // Unknown variant — log and keep going.
        console.warn("[launcher] unknown first-run-progress kind:", payload);
    }
  });

  try {
    const { err } = await safeInvoke("first_run");
    if (err) throw new Error(err);
  } finally {
    unlisten();
  }
}

// --------------------------------------------------------------------------
// Public entry
// --------------------------------------------------------------------------

/**
 * Drive the user through wizard + bootstrap. Resolves only when the user
 * has reached a successful end-state (config saved, bundled_source_version
 * stamped). Retries on bootstrap failure are handled inline — caller does
 * not need to loop.
 */
export async function runFirstRun() {
  showCard("card-wizard");
  await prefillWizard();

  // Loop in case save_initial_config fails (validation, IO); the wizard
  // stays visible and the user retries.
  while (true) {
    const inputs = await awaitWizardSubmit();
    const { err } = await safeInvoke("save_initial_config", inputs);
    if (!err) break;
    showError(els.wizardError(), err);
  }

  // Bootstrap loop — on failure, show a Retry button and stay on the
  // bootstrap card. The user's wizard inputs are already persisted, so
  // we don't have to ask again.
  showCard("card-bootstrap");
  while (true) {
    try {
      await runBootstrap();
      return;
    } catch (err) {
      const message = String(err?.message ?? err);
      showError(els.bootstrapError(), message);

      // Build a Retry + (optional) remediation row.
      if (/git not found on PATH/i.test(message)) {
        // Replace the raw error text with a friendly, styled card.
        clearError(els.bootstrapError());

        const platform = navigator.userAgent.includes("Mac") ? "macos"
          : navigator.userAgent.includes("Win") ? "windows"
          : "linux";

        const card = document.createElement("div");
        card.className = "warning-entry";
        const title = document.createElement("div");
        title.className = "warning-entry__title";
        title.textContent = "I need Git to get set up";
        const body = document.createElement("div");
        body.className = "warning-entry__body";
        body.textContent =
          "Git is a free tool that I use to download my source code and " +
          "keep myself updated. It's one of the most widely-used developer " +
          "tools in the world, and it's perfectly safe to install. " +
          "Once you have it, I'll be able to finish setting up — " +
          "and future updates will work smoothly too.";

        const btnRow = document.createElement("div");
        btnRow.className = "warning-entry__actions";

        const fixBtn = document.createElement("button");
        fixBtn.className = "primary";

        if (platform === "macos") {
          fixBtn.textContent = "Install Command Line Tools";
          fixBtn.addEventListener("click", async () => {
            fixBtn.disabled = true;
            const { err: cltErr } = await safeInvoke("install_xcode_clt");
            if (cltErr) {
              showError(els.bootstrapError(), cltErr);
            } else {
              body.textContent =
                "The installer dialog has opened. Click Install in that " +
                "dialog — once it's done (usually a few minutes), come " +
                "back here and click Try again.";
              fixBtn.textContent = "Installing…";
            }
            fixBtn.disabled = false;
          });
        } else if (platform === "windows") {
          fixBtn.textContent = "Download Git for Windows";
          fixBtn.addEventListener("click", async () => {
            fixBtn.disabled = true;
            await safeInvoke("open_url", {
              url: "https://git-scm.com/download/win",
            });
            body.textContent +=
              "\n\nOnce the download finishes, run the installer, then " +
              "come back here and click Try again.";
            fixBtn.textContent = "Opened in browser";
          });
        } else {
          fixBtn.textContent = "Open install instructions";
          fixBtn.addEventListener("click", async () => {
            fixBtn.disabled = true;
            await safeInvoke("open_url", {
              url: "https://git-scm.com/download/linux",
            });
            body.textContent +=
              "\n\nFollow the instructions for your Linux distribution, " +
              "then come back here and click Try again.";
            fixBtn.textContent = "Opened in browser";
          });
        }
        btnRow.appendChild(fixBtn);

        card.append(title, body, btnRow);
        els.bootstrapActions().replaceChildren(card);

        // Retry goes inside the card's action row alongside the fix button.
        const retry = document.createElement("button");
        retry.textContent = "Try again";
        const clicked = new Promise(
          (r) => retry.addEventListener("click", r),
        );
        btnRow.prepend(retry);

        await clicked;
        els.bootstrapActions().replaceChildren();
        continue; // re-enter the while(true) loop
      }

      const actions = [];
      const retry = document.createElement("button");
      retry.className = "primary";
      retry.textContent = "Try again";
      const clicked = new Promise((r) => retry.addEventListener("click", r));
      actions.push(retry);

      els.bootstrapActions().replaceChildren(...actions);
      await clicked;
      els.bootstrapActions().replaceChildren();
    }
  }
}

// --------------------------------------------------------------------------
// Source-update flow (reuses the bootstrap card UI)
// --------------------------------------------------------------------------

const UPDATE_PHASE_LABELS = {
  "snapshot": "Snapshotting current state…",
  "fetch": "Fetching the latest source…",
  "migrate": "Running migration script…",
  "warm-cache": "Loading new dependencies…",
  "restart": "Restarting myself…",
};

const UPDATE_PHASE_DETAILS = {
  "snapshot": "So I can roll back if something goes sideways.",
  "fetch": "Pulling from GitHub.",
  "migrate": "The new release shipped data-shape changes that need running.",
  "warm-cache": "Usually fast unless new dependencies landed.",
  "restart": "Almost there.",
};

// Update + rollback phase labels share keys with the Rust-emitted
// `source-update-progress` events. Rollback emits `rollback-*`
// phases that aren't shared with the regular update flow.
const ROLLBACK_PHASE_LABELS = {
  "snapshot": "Snapshotting current state…",
  "rollback-stop": "Stopping the daemon…",
  "rollback-restore-data": "Restoring snapshot files…",
  "rollback-source": "Resetting source to the historical tag…",
  "rollback-warm-cache": "Loading dependencies for the historical tag…",
  "rollback-restart": "Restarting myself…",
};

/**
 * Run a source-update operation: fetch the target tag (latest if not
 * specified), re-warm cache, restart daemon. Reuses the bootstrap
 * card's progress ticker for visual consistency with first-run.
 *
 * @param {object} [opts]
 * @param {string} [opts.targetTag] — install this specific tag instead
 *   of the channel's latest. Used by the version picker (§5.17) for
 *   pin / roll-forward / roll-back-without-snapshot.
 */
export async function runSourceUpdate(opts = {}) {
  await runProgressDrivenInvoke({
    title: "Checking for updates…",
    command: "apply_source_update",
    args: opts.targetTag ? { targetTag: opts.targetTag } : {},
    phaseLabels: { ...UPDATE_PHASE_LABELS, ...ROLLBACK_PHASE_LABELS },
    phaseDetails: UPDATE_PHASE_DETAILS,
  });
}

/**
 * Roll back to a recorded snapshot (§5.22). Same progress UI as
 * `runSourceUpdate`, different Rust command + phase set.
 *
 * @param {number} historyIndex — position in get_update_history()'s
 *   list. The launcher resolves the snapshot from the entry.
 */
export async function runRollback(historyIndex) {
  await runProgressDrivenInvoke({
    title: "Rolling back…",
    command: "rollback_to_snapshot",
    args: { historyIndex },
    phaseLabels: ROLLBACK_PHASE_LABELS,
    phaseDetails: {},
  });
}

/**
 * Internal driver. Shows the bootstrap card, listens for
 * `source-update-progress` events, invokes the Rust command, and
 * blocks on a Back button if anything errors. Returns when the
 * operation completes (or the user dismisses an error).
 */
async function runProgressDrivenInvoke(opts) {
  showCard("card-bootstrap");
  resetTicker();
  clearError(els.bootstrapError());
  els.bootstrapActions().replaceChildren();
  els.bootstrapTitle().textContent = opts.title;
  els.bootstrapDetail().textContent = "";

  const unlisten = await listen("source-update-progress", (evt) => {
    const payload = evt.payload || {};
    switch (payload.kind) {
      case "phase": {
        const label = opts.phaseLabels[payload.phase] ??
          `Phase: ${payload.phase}`;
        const detail = opts.phaseDetails[payload.phase] ?? "";
        els.bootstrapTitle().textContent = label;
        els.bootstrapDetail().textContent = detail;
        appendTicker(`── ${label} ──`);
        break;
      }
      case "line":
        appendTicker(payload.line ?? "");
        break;
      case "done": {
        const version = payload.new_version ?? "(unknown)";
        appendTicker(`── Done (now at ${version}) ──`);
        break;
      }
      default:
        console.warn(
          "[launcher] unknown source-update-progress kind:",
          payload,
        );
    }
  });

  try {
    const { err } = await safeInvoke(opts.command, opts.args);
    if (err) throw new Error(err);
  } catch (err) {
    showError(els.bootstrapError(), err);
    const back = document.createElement("button");
    back.textContent = "Back";
    const clicked = new Promise((r) => back.addEventListener("click", r));
    els.bootstrapActions().replaceChildren(back);
    await clicked;
  } finally {
    unlisten();
  }
}

export { showCard };
