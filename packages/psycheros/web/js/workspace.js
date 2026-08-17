/**
 * Workspace UI — client logic
 *
 * - Polls /api/workspace/status for active sessions
 * - Shows/hides the workspace FAB based on capabilities + active sessions
 * - Updates the badge count
 * - Implements openWorkspaceList() — dropdown of active sessions
 * - Sets body.workspace-mode when conversation is workspace-type
 *
 * HTMX-survives pattern: workspace.js is loaded once (NOT inside HTMX-swapped
 * fragments). Functions referenced from onclick handlers must attach to
 * globalThis.Psycheros or be globalThis-exported.
 */

const WORKSPACE_STATUS_URL = "/api/workspace/status";
const WORKSPACE_SESSIONS_URL = "/api/workspace/sessions";
const POLL_INTERVAL_MS = 15_000; // 15 seconds — frequent enough for active session badge

let pollTimer = null;
let lastStatus = null;

// Workspace queries that arrived during an active voice call. Surfacing
// toasts mid-call would interrupt the user; queue them and drain when the
// call ends (drain triggered by voice.js cleanup → drainQueuedWorkspaceQueries).
// Same principle as Pulse queueing during voice, just at the DOM layer where
// the toast actually lives.
const queuedVoiceQueries = [];

function shouldQueueQueryForVoice() {
  return typeof globalThis.isVoiceCallActive === "function" &&
    globalThis.isVoiceCallActive();
}

function drainQueuedWorkspaceQueries() {
  if (queuedVoiceQueries.length === 0) return;
  const toShow = queuedVoiceQueries.splice(0);
  for (const query of toShow) {
    // Skip if the user already answered via /respond while the call was
    // still up (unlikely but possible — they could have used the FAB
    // dropdown directly).
    const existing = document.querySelector(`[data-query-id="${query.id}"]`);
    if (existing) continue;
    showQueryToast(query);
  }
}

// Expose the drain so voice.js cleanup() can call it after ending a call.
globalThis.drainQueuedWorkspaceQueries = drainQueuedWorkspaceQueries;

// =============================================================================
// Status polling
// =============================================================================

async function refreshWorkspaceStatus() {
  try {
    const res = await fetch(WORKSPACE_STATUS_URL, { cache: "no-store" });
    if (!res.ok) {
      hideWorkspaceFab();
      return;
    }
    const data = await res.json();
    lastStatus = data;
    applyStatus(data);
  } catch {
    // Network error or daemon not ready yet — silently hide.
    hideWorkspaceFab();
  }
}

function applyStatus(data) {
  const fab = document.getElementById("workspace-btn");
  if (!fab) return;

  // Show FAB only when there's something to act on: an active or suspended
  // session (watch the terminal, answer a pending question). Idle + nothing
  // pending = hidden. Completion flashes a brief checkmark via the
  // workspace_async_complete listener, then this poll re-hides it.
  const shouldShow = (data?.activeSessionCount ?? 0) > 0;
  if (!shouldShow) {
    hideWorkspaceFab();
    return;
  }

  fab.style.display = "flex";
  fab.classList.add("is-shown");

  // Active state — pulse animation when sessions are running.
  const hasRunning = (data?.activeSessions ?? []).some(
    (s) => s.status === "running" || s.status === "pending",
  );
  fab.classList.toggle("is-active", hasRunning);

  // Stalled state — amber slow-pulse when any active session has gone silent
  // (no OpenCode events for ~90s, not waiting on user). Purely informational;
  // the 5-min hard timeout still kills the subprocess. The 15s poll catches
  // this; the workspace_stalled SSE event catches it immediately.
  const hasStalled = (data?.activeSessions ?? []).some((s) => s.stalled);
  fab.classList.toggle("is-stalled", hasStalled);

  // Badge count.
  const badge = document.getElementById("workspace-fab-badge");
  if (badge) {
    const count = data?.activeSessionCount ?? 0;
    if (count > 0) {
      badge.style.display = "flex";
      badge.textContent = String(count);
    } else {
      badge.style.display = "none";
    }
  }

  // The amber `!` overlay is driven by updateFabAlert() (queries-based), not
  // by session status here. Session status has a race: the workspace_query
  // SSE event fires before the supervisor marks the session suspended, so
  // reading status at that moment shows "running" and the badge stays hidden.
  // Queries are the source of truth for "is something pending."
}

/**
 * Update the amber `!` overlay on the FAB based on pending queries.
 * The badge reflects "any ask_origin_conversation / ask_user is awaiting
 * an answer" — independent of which conversation the user is viewing.
 *
 * Per plan §14 #6: FAB is cross-conversation. This fetches the global
 * pending-query list and toggles the overlay.
 */
async function updateFabAlert() {
  const alert = document.getElementById("workspace-fab-alert");
  if (!alert) return;
  try {
    const res = await fetch("/api/workspace/queries", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const count = (data.pending ?? []).length;
    alert.style.display = count > 0 ? "flex" : "none";
  } catch {
    // Network error — leave the badge as-is.
  }
}

function hideWorkspaceFab() {
  const fab = document.getElementById("workspace-btn");
  if (!fab) return;
  fab.style.display = "none";
  fab.classList.remove("is-shown", "is-active");
}

// =============================================================================
// Session list dropdown
// =============================================================================

async function openWorkspaceList() {
  // If dropdown already open, close it.
  const existing = document.querySelector(".workspace-list-dropdown");
  if (existing) {
    existing.remove();
    return;
  }

  // Fetch sessions (active + recent) AND pending queries in parallel — the
  // query list drives the recovery section (per plan §14 #4: dropdown is
  // the recovery path after browser refresh, since SSE doesn't replay).
  const [sessionsRes, queriesRes] = await Promise.all([
    fetch(WORKSPACE_SESSIONS_URL, { cache: "no-store" }).catch(() => null),
    fetch("/api/workspace/queries", { cache: "no-store" }).catch(() => null),
  ]);

  let sessions = [];
  if (sessionsRes && sessionsRes.ok) {
    const data = await sessionsRes.json();
    sessions = data.sessions ?? [];
  }
  // Also include any active sessions from the last status poll.
  if (lastStatus?.activeSessions) {
    const seenIds = new Set(sessions.map((s) => s.id));
    for (const s of lastStatus.activeSessions) {
      if (!seenIds.has(s.id)) sessions.push(s);
    }
  }

  let pendingQueries = [];
  if (queriesRes && queriesRes.ok) {
    const data = await queriesRes.json();
    pendingQueries = data.pending ?? [];
  }

  const dropdown = document.createElement("div");
  dropdown.className = "workspace-list-dropdown";
  dropdown.setAttribute("role", "menu");
  dropdown.tabIndex = -1;

  // Pending questions section — surfaces when sessions are suspended
  // (plan §14). Click re-opens the toast so the user can answer. The
  // session goal is shown alongside the question for disambiguation when
  // multiple workspaces are pending (§14 edge case 1, 11).
  if (pendingQueries.length > 0) {
    const qHeader = document.createElement("div");
    qHeader.className = "list-header list-header-pending";
    qHeader.textContent =
      `Pending questions — ${pendingQueries.length}`;
    dropdown.appendChild(qHeader);

    for (const query of pendingQueries) {
      const row = document.createElement("div");
      row.className = "query-row";
      row.setAttribute("data-query-id", query.id);
      row.tabIndex = 0;

      const icon = document.createElement("span");
      icon.className = "query-icon";
      icon.textContent = "?";
      row.appendChild(icon);

      const body = document.createElement("div");
      body.className = "query-body";

      const qText = document.createElement("div");
      qText.className = "query-text";
      qText.textContent = query.question;
      body.appendChild(qText);

      // Disambiguation: which workspace asked?
      const session = sessions.find((s) => s.id === query.sessionId);
      if (session) {
        const goal = document.createElement("div");
        goal.className = "query-goal";
        goal.textContent =
          `from: ${session.briefing?.goal || session.goal || "(no goal)"}`;
        body.appendChild(goal);
      }

      row.appendChild(body);

      // Click anywhere on the row → re-open toast + close dropdown.
      const reopen = () => {
        closeWorkspaceList();
        // If a toast is already up for this query (e.g. user clicked the
        // FAB while the toast was idle-dismissed but still in DOM), just
        // focus its input.
        const existingToast = document.querySelector(
          `[data-query-id="${query.id}"]`,
        );
        if (existingToast) {
          const input = existingToast.querySelector(".toast-input");
          if (input) input.focus();
          return;
        }
        showQueryToast(query);
      };
      row.addEventListener("click", reopen);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          reopen();
        }
      });

      dropdown.appendChild(row);
    }

    // Divider between sections if there are also active sessions.
    if (sessions.length > 0) {
      const divider = document.createElement("div");
      divider.className = "list-divider";
      dropdown.appendChild(divider);
    }
  }

  if (sessions.length === 0 && pendingQueries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No active workspace sessions.";
    dropdown.appendChild(empty);
  } else if (sessions.length === 0) {
    // Pending queries but no active sessions — sessions list is just empty,
    // no header. (Pending section already rendered above.)
  } else {
    const header = document.createElement("div");
    header.className = "list-header";
    header.textContent =
      `Workspace sessions — ${sessions.length} active`;
    dropdown.appendChild(header);

    for (const session of sessions) {
      const row = document.createElement("a");
      row.className = "session-row";
      row.href = `/c/${session.conversationId}`;
      row.setAttribute("data-session-id", session.id);

      const status = document.createElement("span");
      status.className = `session-status ${session.status}`;
      row.appendChild(status);

      const goal = document.createElement("div");
      goal.className = "session-goal";
      goal.textContent = session.briefing?.goal || session.goal ||
        "(no goal recorded)";
      row.appendChild(goal);

      const meta = document.createElement("div");
      meta.className = "session-meta";
      const mode = session.mode ?? "sync";
      // Partyhard badge suppressed 2026-08-12 — mode is disabled server-side.
      meta.textContent = `${mode} · ${session.status}`;
      row.appendChild(meta);

      row.addEventListener("click", (e) => {
        e.preventDefault();
        // Suspended sessions have a pending question — don't navigate to the
        // (visually blank) workspace conversation. Re-open the toast in the
        // user's current conversation so they can answer without losing
        // context. Per plan §14 #4 — dropdown is the recovery path.
        if (session.status === "suspended") {
          closeWorkspaceList();
          // Look up the pending query for this session and re-show its toast.
          fetch("/api/workspace/queries", { cache: "no-store" })
            .then((r) => r.ok ? r.json() : { pending: [] })
            .then((data) => {
              const q = (data.pending ?? []).find(
                (p) => p.sessionId === session.id,
              );
              if (!q) {
                // No toast to re-open — fall back to navigating.
                window.location.href = `/c/${session.conversationId}`;
                return;
              }
              const existing = document.querySelector(
                `[data-query-id="${q.id}"]`,
              );
              if (existing) {
                const input = existing.querySelector(".toast-input");
                if (input) input.focus();
              } else {
                showQueryToast(q);
              }
            })
            .catch(() => {
              window.location.href = `/c/${session.conversationId}`;
            });
          return;
        }
        closeWorkspaceList();
        window.location.href = `/c/${session.conversationId}`;
      });

      // Cancel button — user killswitch. Stops on click, doesn't navigate.
      if (session.status === "running" || session.status === "pending") {
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "session-cancel-btn";
        cancelBtn.textContent = "Cancel";
        cancelBtn.title = "Kill this workspace session";
        cancelBtn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          cancelBtn.disabled = true;
          cancelBtn.textContent = "Cancelling...";
          try {
            const res = await fetch(
              `/api/workspace/sessions/${session.id}/cancel`,
              { method: "POST" },
            );
            if (res.ok) {
              cancelBtn.textContent = "Cancelled";
              setTimeout(() => closeWorkspaceList(), 800);
            } else {
              cancelBtn.textContent = "Failed";
              cancelBtn.disabled = false;
            }
          } catch {
            cancelBtn.textContent = "Error";
            cancelBtn.disabled = false;
          }
        };
        row.appendChild(cancelBtn);
      }

      dropdown.appendChild(row);
    }
  }

  document.body.appendChild(dropdown);
  dropdown.focus();

  // Click outside to close.
  setTimeout(() => {
    document.addEventListener("click", closeWorkspaceListOnOutside, {
      once: true,
    });
  }, 0);
}

function closeWorkspaceList() {
  const dropdown = document.querySelector(".workspace-list-dropdown");
  if (dropdown) dropdown.remove();
}

function closeWorkspaceListOnOutside(e) {
  const dropdown = document.querySelector(".workspace-list-dropdown");
  const fab = document.getElementById("workspace-btn");
  if (!dropdown) return;
  if (dropdown.contains(e.target) || (fab && fab.contains(e.target))) {
    // Click inside dropdown or on FAB — re-arm the handler.
    document.addEventListener("click", closeWorkspaceListOnOutside, {
      once: true,
    });
    return;
  }
  closeWorkspaceList();
}

// =============================================================================
// Conversation navigation
// =============================================================================

function navigateToConversation(conversationId) {
  if (globalThis.Psycheros?.selectConversation) {
    globalThis.Psycheros.selectConversation(conversationId);
    return;
  }
  // Fallback — direct URL navigation.
  globalThis.location.href = `/c/${conversationId}`;
}

// =============================================================================
// Body class for workspace-mode (terminal aesthetic)
//
// Applied when the active conversation has sourceType="workspace".
// The chat container picks up terminal styling via body.workspace-mode.
//
// Caveat: the only reliable signal we have client-side is the body attribute
// the server sets at initial render (`<body data-workspace-conversation="true">`
// when initial-loading a workspace conversation). HTMX swaps don't re-render
// the body, so the attribute can go stale after navigating from a workspace
// conversation back to main chat. To detect that, we capture the initial
// workspace conversation ID at load time; if currentConversationId() differs,
// we know we've navigated and should clear the class. (A proper fix would
// add a /api/conversations/:id endpoint that returns sourceType — tracked as
// a known gap.)
// =============================================================================

// Captured at initial load: if the body tagged itself as a workspace
// conversation, this is the conversation ID it was tagged FOR. Used to
// detect stale attribute after navigation.
const initialWorkspaceConversationId = (() => {
  if (document.body.getAttribute("data-workspace-conversation") !== "true") {
    return null;
  }
  const m = globalThis.location.pathname.match(/^\/c\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
})();

async function refreshWorkspaceMode() {
  const convId = currentConversationId();
  if (!convId) {
    document.body.classList.remove("workspace-mode");
    return;
  }

  // If we navigated away from the initial workspace conversation, the body
  // attribute is stale — clear it. (The server doesn't set the attribute
  // for non-workspace conversations, so absence is the natural state.)
  if (
    initialWorkspaceConversationId &&
    convId !== initialWorkspaceConversationId
  ) {
    document.body.classList.remove("workspace-mode");
    return;
  }

  try {
    const sourceType = findConversationSourceType(convId);
    document.body.classList.toggle("workspace-mode", sourceType === "workspace");
  } catch {
    // Best-effort — don't crash on missing data.
  }
}

function currentConversationId() {
  const m = globalThis.location.pathname.match(/^\/c\/([^/]+)$/);
  return m ? m[1] : null;
}

function findConversationSourceType(_conversationId) {
  // Phase 1 stub — we don't have a clean way to read sourceType from the
  // client yet. The server-rendered sidebar HTML includes source_type
  // data attributes for Discord/etc., but workspace conversations aren't
  // in the main sidebar. Phase 2 will add a /api/conversations/:id endpoint
  // that returns sourceType so we can detect this reliably.
  //
  // For now: detect via the URL pattern in referrer or a body[data-workspace]
  // attribute set server-side. This is a known gap — terminal aesthetic
  // activates manually via body class until Phase 2 wires the detection.
  return document.body.getAttribute("data-workspace-conversation") === "true"
    ? "workspace"
    : null;
}

// =============================================================================
// Init
// =============================================================================

function startWorkspacePolling() {
  if (pollTimer) clearInterval(pollTimer);
  // Initial poll immediately, then on interval.
  refreshWorkspaceStatus();
  refreshWorkspaceMode();
  updateFabAlert();
  pollTimer = setInterval(() => {
    refreshWorkspaceStatus();
    refreshWorkspaceMode();
    updateFabAlert();
  }, POLL_INTERVAL_MS);
}

function stopWorkspacePolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Re-evaluate workspace mode after HTMX swaps #chat (new conversation loaded).
document.addEventListener("htmx:afterSwap", (e) => {
  if (e.detail?.target?.id === "chat") {
    refreshWorkspaceMode();
  }
});

// =============================================================================
// Approval prompts + query-back cards
//
// These surface as toasts above the chat bar (mobile-first, not top-right
// per design). Listen for SSE events from /api/events and render dismissible
// cards. Approve/Deny buttons POST to /api/workspace/approvals/:id/{action}.
// =============================================================================

function startWorkspaceEventListener() {
  // Psycheros's SSE event stream is at /api/events. We listen for typed events.
  // The browser's EventSource API auto-reconnects, so this is resilient.
  let es;
  try {
    es = new EventSource("/api/events");
  } catch {
    return; // EventSource unavailable — silent failure
  }

  es.addEventListener("workspace_approval_request", (e) => {
    try {
      const proposal = JSON.parse(e.data);
      showApprovalToast(proposal);
    } catch {
      // ignore malformed event
    }
  });

  es.addEventListener("workspace_approval_resolved", (e) => {
    try {
      const data = JSON.parse(e.data);
      dismissApprovalToast(data.id);
    } catch {
      // ignore
    }
  });

  es.addEventListener("workspace_query", (e) => {
    try {
      const query = JSON.parse(e.data);
      // Per plan §14 edge case 12: queue during voice calls, drain on end.
      // Mid-call toasts would cut off the user mid-utterance.
      if (shouldQueueQueryForVoice()) {
        queuedVoiceQueries.push(query);
      } else {
        showQueryToast(query);
      }
    } catch {
      // ignore
    }
    // Toggle the `!` overlay from the queries endpoint (source of truth).
    // Avoids the race where session.status is still "running" at this moment.
    updateFabAlert();
  });

  es.addEventListener("workspace_query_resolved", (e) => {
    try {
      const data = JSON.parse(e.data);
      dismissQueryToast(data.id);
    } catch {
      // ignore
    }
    updateFabAlert();
  });

  // Live transcript streaming: render workspace events as DOM additions to
  // the #messages container when the user is viewing a workspace conversation.
  // Per ephemeral principle: events are NOT stored in DB; this live render is
  // the only place they exist. Once the user navigates away, they're gone.
  es.addEventListener("workspace_event", (e) => {
    try {
      const data = JSON.parse(e.data);
      renderLiveWorkspaceEvent(data);
    } catch {
      // ignore malformed event
    }
  });

  // Stall transitions — refresh the FAB immediately rather than waiting for
  // the 15s poll. The supervisor's heartbeat watchdog fires these when an
  // active session crosses the no-events threshold (or recovers).
  es.addEventListener("workspace_stalled", () => {
    refreshWorkspaceStatus();
  });
  es.addEventListener("workspace_resumed", () => {
    refreshWorkspaceStatus();
  });

  // Session completed while the user is watching the terminal — append the
  // summary block so the view ends on the load-bearing artifact.
  es.addEventListener("workspace_async_complete", (e) => {
    let data = {};
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    // FAB completion flash — brief green checkmark regardless of the current
    // view, then re-evaluate visibility (hides if nothing else is active).
    flashFabComplete();
    const termEl = document.getElementById("workspace-terminal");
    if (!termEl) return;
    const myConvId = currentConversationId();
    if (data.conversationId && myConvId && data.conversationId !== myConvId) {
      return;
    }
    const output = document.getElementById("wt-output");
    if (!output || !data.summary) return;
    const liveNote = document.getElementById("wt-live-note");
    if (liveNote) liveNote.remove();
    const block = document.createElement("div");
    block.className = "wt-block wt-summary";
    const label = document.createElement("div");
    label.className = "wt-block-label";
    label.textContent = data.ok ? "summary" : "failed";
    const text = document.createElement("div");
    text.className = "wt-text";
    text.textContent = data.summary;
    block.appendChild(label);
    block.appendChild(text);
    output.appendChild(block);
    output.scrollTop = output.scrollHeight;
    setTerminalFooter(data.ok ? "complete" : "failed", true);
  });
}

/**
 * Render a live workspace event as a DOM addition to the open conversation.
 *
 * Guards (both must hold — defense-in-depth):
 *   1. body.workspace-mode class is set (only on workspace conversations)
 *   2. data.conversationId matches the conversation the user is viewing
 *
 * The body class alone is unsafe: a stale `data-workspace-conversation`
 * attribute on the body element (e.g. from a previous workspace
 * conversation visit that wasn't cleared on navigation) plus a global SSE
 * listener that receives ALL workspace_event broadcasts (the broadcaster
 * sends global listeners everything regardless of scope) would leak live
 * transcript DOM into the origin conversation. The conversation-id check
 * closes that hole.
 */
function renderLiveWorkspaceEvent(data) {
  // Terminal pane path — workspace conversations render the terminal, not
  // the chat view. Guard on the pane's presence rather than body class so
  // this works even if the workspace-mode body class lags a swap.
  const termEl = document.getElementById("workspace-terminal");
  if (!termEl) return;

  // The event carries the workspace conversation ID it was scoped to. Only
  // render if the user is viewing that exact conversation.
  const myConvId = currentConversationId();
  if (data.conversationId && myConvId && data.conversationId !== myConvId) {
    return;
  }
  // Defense-in-depth: also check the pane's own conversation id.
  const paneConvId = termEl.getAttribute("data-conversation-id");
  if (data.conversationId && paneConvId && data.conversationId !== paneConvId) {
    return;
  }

  const output = document.getElementById("wt-output");
  if (!output) return;

  // Drop the "waiting for events" note on the first real line.
  const liveNote = document.getElementById("wt-live-note");
  if (liveNote) liveNote.remove();

  const entityName =
    termEl.getAttribute("data-entity-name") || data.entityName || "entity";
  const kind = data.kind;

  const line = document.createElement("div");

  if (kind === "entity") {
    line.className = "wt-line wt-line--entity";
    const name = document.createElement("span");
    name.className = "wt-entity-name";
    name.textContent = entityName;
    const text = document.createElement("span");
    text.className = "wt-text";
    text.textContent = data.content || "";
    line.appendChild(name);
    line.appendChild(text);
  } else if (kind === "tool") {
    line.className = "wt-line wt-line--tool";
    const prefix = document.createElement("span");
    prefix.className = "wt-tool-prefix";
    prefix.textContent = `$ ${data.tool || "tool"}`;
    const text = document.createElement("span");
    text.className = "wt-text wt-dim";
    text.textContent = data.content || "";
    line.appendChild(prefix);
    line.appendChild(text);
  } else if (kind === "tool_result") {
    line.className = "wt-line wt-line--result";
    const text = document.createElement("span");
    text.className = "wt-text wt-dim";
    text.textContent = data.content || "";
    line.appendChild(text);
  } else if (kind === "error") {
    line.className = "wt-line wt-line--error";
    const text = document.createElement("span");
    text.className = "wt-text";
    text.textContent = data.content || "";
    line.appendChild(text);
  } else if (kind === "status") {
    // Terminal status (failed/cancelled) — footer + a status line.
    setTerminalFooter(`session ${data.status || "ended"}`, true);
    line.className = "wt-line wt-line--status";
    const text = document.createElement("span");
    text.className = "wt-text";
    text.textContent = data.content || "";
    line.appendChild(text);
  } else {
    // text (default) — plain streaming output line.
    line.className = "wt-line wt-line--output";
    const src = document.createElement("span");
    src.className = "wt-src";
    src.textContent = "opencode";
    const text = document.createElement("span");
    text.className = "wt-text";
    text.textContent = data.content || "";
    line.appendChild(src);
    line.appendChild(text);
  }

  output.appendChild(line);
  output.scrollTop = output.scrollHeight;
  if (kind !== "status") setTerminalFooter("streaming", false);
}

/**
 * Update the terminal footer status text. `ended` stops the cursor blink.
 */
function setTerminalFooter(text, ended) {
  const footerText = document.querySelector("#wt-footer .wt-footer-text");
  if (footerText) footerText.textContent = text;
  const footer = document.getElementById("wt-footer");
  if (footer && ended) footer.classList.add("wt-footer--ended");
}

/**
 * Brief green checkmark on the FAB when a workspace completes — the "it
 * finished" signal. After the flash, visibility is re-evaluated by poll, so
 * the FAB hides again if no sessions remain.
 */
let fabCompleteTimer = null;
function flashFabComplete() {
  const fab = document.getElementById("workspace-btn");
  if (!fab) return;
  fab.style.display = "flex";
  fab.classList.add("is-complete");
  if (fabCompleteTimer) clearTimeout(fabCompleteTimer);
  fabCompleteTimer = setTimeout(() => {
    fab.classList.remove("is-complete");
    // Re-evaluate: hides if nothing is active anymore.
    refreshWorkspaceStatus();
  }, 6000);
}

function showApprovalToast(proposal) {
  // Don't duplicate if already shown.
  if (document.querySelector(`[data-approval-id="${proposal.id}"]`)) return;

  const toast = document.createElement("div");
  toast.className = "workspace-toast workspace-approval-toast";
  toast.setAttribute("data-approval-id", proposal.id);
  toast.setAttribute("role", "alert");

  const title = document.createElement("div");
  title.className = "toast-title";
  // "custom"-type proposals carry an action (install/export) that reads
  // better than "modify custom".
  const action = proposal.changes?.action;
  const verb = action === "export"
    ? "export a project"
    : action === "install"
    ? "install a plugin"
    : action === "bind"
    ? `work in ${proposal.changes?.workdir ?? "a folder"}`
    : `modify ${proposal.type}`;
  title.textContent = `⚠ request to ${verb}`;
  toast.appendChild(title);

  const target = document.createElement("div");
  target.className = "toast-target";
  target.textContent = `Target: ${proposal.targetId}`;
  toast.appendChild(target);

  const justification = document.createElement("div");
  justification.className = "toast-justification";
  justification.textContent = `Justification: ${proposal.justification}`;
  toast.appendChild(justification);

  if (proposal.reflectionRecommendation) {
    const reflection = document.createElement("div");
    reflection.className = "toast-reflection";
    reflection.textContent = `Reflection: ${proposal.reflectionRecommendation.reasoning}`;
    toast.appendChild(reflection);
  }

  if (proposal.diffPreview?.summary) {
    const summary = document.createElement("div");
    summary.className = "toast-diff-summary";
    summary.textContent = `Change: ${proposal.diffPreview.summary}`;
    toast.appendChild(summary);
  }

  if (proposal.diffPreview?.after) {
    const diff = document.createElement("pre");
    diff.className = "toast-diff";
    diff.textContent = proposal.diffPreview.after;
    toast.appendChild(diff);
  }

  const actions = document.createElement("div");
  actions.className = "toast-actions";

  const showDiffBtn = document.createElement("button");
  showDiffBtn.textContent = "Details";
  showDiffBtn.className = "btn-secondary";
  showDiffBtn.onclick = () => toggleApprovalDetails(toast);
  actions.appendChild(showDiffBtn);

  const denyBtn = document.createElement("button");
  denyBtn.textContent = "Deny";
  denyBtn.className = "btn-deny";
  denyBtn.onclick = () => submitApprovalDecision(proposal.id, false);
  actions.appendChild(denyBtn);

  const approveBtn = document.createElement("button");
  approveBtn.textContent = "Approve";
  approveBtn.className = "btn-approve";
  approveBtn.onclick = () => submitApprovalDecision(proposal.id, true);
  actions.appendChild(approveBtn);

  toast.appendChild(actions);
  document.body.appendChild(toast);

  // Auto-dismiss after 5 minutes (matches the queue's expiration timeout).
  setTimeout(() => dismissApprovalToast(proposal.id), 5 * 60_000);
}

function toggleApprovalDetails(toast) {
  const diff = toast.querySelector(".toast-diff");
  if (diff) {
    const isHidden = diff.style.display === "none" || !diff.style.display;
    diff.style.display = isHidden ? "block" : "none";
  }
}

async function submitApprovalDecision(approvalId, approve) {
  const toast = document.querySelector(`[data-approval-id="${approvalId}"]`);
  try {
    const res = await fetch(
      `/api/workspace/approvals/${approvalId}/${approve ? "approve" : "deny"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decidedBy: "user" }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error || `HTTP ${res.status}`;
      showInlineToastError(toast, `Failed to ${approve ? "approve" : "deny"}: ${msg}`);
      console.error("Approval decision failed:", err);
      return;
    }
    dismissApprovalToast(approvalId);
  } catch (err) {
    showInlineToastError(toast, `Network error: ${err.message}`);
    console.error("Approval decision network error:", err);
  }
}

function dismissApprovalToast(approvalId) {
  const toast = document.querySelector(
    `[data-approval-id="${approvalId}"]`,
  );
  if (toast) {
    toast.classList.add("is-resolved");
    setTimeout(() => toast.remove(), 300);
  }
}

const QUERY_TOAST_IDLE_MS = 5 * 60 * 1000;

function showQueryToast(query) {
  if (document.querySelector(`[data-query-id="${query.id}"]`)) return;

  const toast = document.createElement("div");
  toast.className = "workspace-toast workspace-query-toast";
  toast.setAttribute("data-query-id", query.id);
  toast.setAttribute("role", "alert");

  const title = document.createElement("div");
  title.className = "toast-title";
  title.textContent = "Workspace question";
  toast.appendChild(title);

  const question = document.createElement("div");
  question.className = "toast-question";
  question.textContent = query.question;
  toast.appendChild(question);

  const form = document.createElement("div");
  form.className = "toast-form";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "toast-input";
  input.placeholder = "Your answer...";
  form.appendChild(input);

  const submitBtn = document.createElement("button");
  submitBtn.textContent = "Answer";
  submitBtn.className = "btn-approve";
  submitBtn.onclick = () => submitQueryAnswer(query, input.value);
  form.appendChild(submitBtn);

  toast.appendChild(form);
  document.body.appendChild(toast);

  input.focus();

  // Enter key submits
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitQueryAnswer(query, input.value);
    }
  });

  // Per plan §14 (revised 2026-08-10): 5-min idle timer signals the server
  // to suspend the workspace. While the toast is up the workspace stays
  // RUNNING with the OpenCode process blocked on ask_origin_conversation.
  // After 5 min of no engagement, we POST /suspend — the server unblocks
  // the tool call (OpenCode ends its turn) and marks the session suspended.
  // The `!` badge on the FAB takes over as the recovery path. Any
  // interaction (focus, typing) resets the timer. No visible countdown.
  let idleTimer = setTimeout(() => {
    signalSuspendViaApi(query.id);
  }, QUERY_TOAST_IDLE_MS);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      signalSuspendViaApi(query.id);
    }, QUERY_TOAST_IDLE_MS);
  };
  input.addEventListener("focus", resetIdle);
  input.addEventListener("input", resetIdle);
  input.addEventListener("keydown", resetIdle);
  // Stash the timer on the toast so dismissQueryToast can cancel it (e.g.
  // when the user submits successfully or the query is resolved via SSE).
  toast.dataset.idleTimerActive = "true";
  toast._idleReset = resetIdle;
  toast._idleCancel = () => clearTimeout(idleTimer);
}

/**
 * POST to the server's /suspend endpoint. The server resolves the blocked
 * tool call and marks the session suspended. Locally dismiss the toast —
 * the `!` badge takes over via updateFabAlert() (query is still pending
 * server-side, so the badge still shows).
 */
async function signalSuspendViaApi(queryId) {
  try {
    await fetch(`/api/workspace/queries/${queryId}/suspend`, {
      method: "POST",
    });
  } catch {
    // Network error — the server's 30-min hard cap will eventually fire
    // and clean up. Don't surface an error to the user.
  }
  dismissQueryToast(queryId);
}

async function submitQueryAnswer(query, answer) {
  if (!answer.trim()) return;
  const toast = document.querySelector(`[data-query-id="${query.id}"]`);
  try {
    const res = await fetch(
      `/api/workspace/sessions/${query.sessionId}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queryId: query.id, answer }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error || `HTTP ${res.status}`;
      showInlineToastError(toast, `Failed to send answer: ${msg}`);
      console.error("Query answer failed:", err);
      return;
    }
    dismissQueryToast(query.id);
  } catch (err) {
    showInlineToastError(toast, `Network error: ${err.message}`);
    console.error("Query answer network error:", err);
  }
}

/**
 * Show an error message inside a toast without dismissing it. Lets the user
 * retry or see what went wrong instead of silently dropping their input.
 */
function showInlineToastError(toast, message) {
  if (!toast) return;
  // Remove any prior error.
  toast.querySelectorAll(".toast-error").forEach((e) => e.remove());
  const err = document.createElement("div");
  err.className = "toast-error";
  err.textContent = message;
  toast.appendChild(err);
}

function dismissQueryToast(queryId) {
  const toast = document.querySelector(`[data-query-id="${queryId}"]`);
  if (toast) {
    // Cancel any pending idle timer so it doesn't fire after dismissal.
    if (typeof toast._idleCancel === "function") toast._idleCancel();
    toast.classList.add("is-resolved");
    setTimeout(() => toast.remove(), 300);
  }
}

/**
 * Fetch any queries + approvals that were pending before page refresh.
 * EventSource doesn't replay missed events, so without this the user
 * would never see toasts for queries that fired while the page was reloading.
 */
async function recoverPendingToasts() {
  try {
    const [queriesRes, approvalsRes] = await Promise.all([
      fetch("/api/workspace/queries", { cache: "no-store" }),
      fetch("/api/workspace/approvals", { cache: "no-store" }),
    ]);
    if (queriesRes.ok) {
      const data = await queriesRes.json();
      for (const q of data.pending ?? []) {
        showQueryToast(q);
      }
    }
    if (approvalsRes.ok) {
      const data = await approvalsRes.json();
      for (const p of data.pending ?? []) {
        showApprovalToast(p);
      }
    }
  } catch (err) {
    console.warn("[workspace] recovery fetch failed:", err);
  }
}

// =============================================================================
// Init (combined)
// =============================================================================

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    startWorkspacePolling();
    startWorkspaceEventListener();
    recoverPendingToasts();
  });
} else {
  startWorkspacePolling();
  startWorkspaceEventListener();
  recoverPendingToasts();
}

/**
 * Save workspace settings form. Reads form fields, POSTs JSON, surfaces
 * a brief success/failure indicator inline.
 */
async function saveWorkspaceSettings(form) {
  if (!form) return false;
  const data = {
    contextBlock: form.contextBlock?.value ?? "",
    // partyhardDefault disabled 2026-08-12 (mode disabled server-side).
    // Field kept in the persisted JSON for compatibility with older saves.
    partyhardDefault: false,
    defaultIsolation: form.defaultIsolation?.value ?? "sandboxed",
    opencodeBinaryPath: form.opencodeBinaryPath?.value ?? "",
    projectsPath: form.projectsPath?.value ?? "",
    forwardLlmProfile: form.forwardLlmProfile?.checked ?? true,
    alwaysAskPaths: form.alwaysAskPaths?.value ?? "",
    houseRules: form.houseRules?.value ?? "",
    llmProfileId: form.llmProfileId?.value ?? "",
    sandboxRetentionDays: Number(form.sandboxRetentionDays?.value ?? 7) || 0,
  };

  try {
    const res = await fetch("/api/workspace/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert("Failed to save workspace settings: " + (err.error || res.status));
      return false;
    }
    // Brief success indicator — replace button text temporarily.
    const btn = form.querySelector('button[type="button"]');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = "✓ Saved";
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = orig;
        btn.disabled = false;
      }, 1500);
    }
  } catch (err) {
    alert("Network error saving settings: " + err.message);
    return false;
  }
  return false;
}

// =============================================================================
// Export to globalThis for onclick handlers (HTMX-survives pattern per CLAUDE.md)
// =============================================================================

/**
 * Tab switcher for Settings > Workspace (General / Sessions). Lives here —
 * not inline — because HTMX doesn't reliably re-execute swapped scripts.
 */
function switchWorkspaceTab(tab) {
  document.querySelectorAll(
    ".workspace-settings .settings-tab[data-tab]",
  ).forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.getElementById("workspace-tab-general").style.display =
    tab === "general" ? "" : "none";
  document.getElementById("workspace-tab-sessions").style.display =
    tab === "sessions" ? "" : "none";
}

/**
 * Toggle a session's retention-exemption pin from the Settings > Workspace
 * management list. Refreshes the settings fragment after so both lists
 * (pinned + recent) re-render.
 */
async function toggleWorkspacePin(sessionId, pinned, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = pinned ? "Pinning..." : "Unpinning...";
  }
  try {
    const res = await fetch(`/api/workspace/sessions/${sessionId}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    refreshWorkspaceStatus();

    // Refresh ONLY the sessions panel — swapping the whole fragment via
    // htmx would reset to the server-rendered General tab. Fetch, parse,
    // replace the one node; tab state is never touched.
    const fragRes = await fetch("/fragments/settings/workspace", {
      cache: "no-store",
    });
    if (fragRes.ok) {
      const doc = new DOMParser().parseFromString(
        await fragRes.text(),
        "text/html",
      );
      const fresh = doc.getElementById("workspace-tab-sessions");
      const live = document.getElementById("workspace-tab-sessions");
      if (fresh && live) {
        fresh.style.display = ""; // parsed node carries display:none
        live.replaceWith(fresh);
      }
    }
  } catch (err) {
    if (btn) {
      btn.textContent = "Failed";
      btn.disabled = false;
    }
    console.error("[workspace] pin toggle failed:", err);
  }
}

if (globalThis.Psycheros) {
  globalThis.Psycheros.openWorkspaceList = openWorkspaceList;
  globalThis.Psycheros.saveWorkspaceSettings = saveWorkspaceSettings;
  globalThis.Psycheros.toggleWorkspacePin = toggleWorkspacePin;
  globalThis.Psycheros.switchWorkspaceTab = switchWorkspaceTab;
} else {
  // Psycheros object not yet defined — defer attachment until it is.
  Object.defineProperty(globalThis, "Psycheros", {
    configurable: true,
    set(psycheros) {
      Object.defineProperty(globalThis, "Psycheros", {
        configurable: true,
        writable: true,
        value: psycheros,
      });
      if (psycheros && typeof psycheros === "object") {
        psycheros.openWorkspaceList = openWorkspaceList;
        psycheros.saveWorkspaceSettings = saveWorkspaceSettings;
        psycheros.toggleWorkspacePin = toggleWorkspacePin;
        psycheros.switchWorkspaceTab = switchWorkspaceTab;
      }
    },
  });
}

globalThis.refreshWorkspaceStatus = refreshWorkspaceStatus;
