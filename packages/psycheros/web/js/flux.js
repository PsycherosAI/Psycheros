/**
 * Flux overlay — the conversation-hosted Flux interface (Voice-Chat
 * overlay pattern).
 *
 * All overlay logic lives HERE, never in the fragment: scripts inserted
 * via innerHTML never execute (the HTMX rule; same reason voice.js holds
 * the voice overlay's logic). The fragment carries markup + JSON config
 * tags only.
 *
 * Mount: startFluxOverlay(conversationId) — POSTs the flux start (with
 * the host binding; a refusal toasts and aborts), fetches the fragment,
 * peeks its config, mounts to document.body. Own EventSource (closed in
 * cleanup). Teardown: stop double-tap-confirm, then cleanup() removes
 * the overlay and pull-refreshes the conversation (Psycheros.
 * selectConversation) so the thread shows the dialogue written during
 * the session.
 */

let overlayActive = false;
let es = null;
let pollTimer = null;
let toastTimer = null;
let conversationId = null;
let thinkingCard = null;
let generatingEl = null;
let liveEgo = null;
let stopArmed = false;
let stopDisarmTimer = null;


// ---------------------------------------------------------------------------
// Scroll behavior — classic chat's AutoScroll pattern: follow the stream
// only while latched to the bottom; scrolled-up reading is never yanked.
// New content lights a badge on the scroll-to-bottom pill instead.
// Reuses .scroll-to-bottom-pill from components.css (app shell CSS).
// ---------------------------------------------------------------------------
const FluxScroll = (() => {
  const NEAR_BOTTOM = 80; // px
  let el = null;
  let pill = null;
  let badge = null;
  let latched = true;
  let hasNew = false;

  function setup() {
    el = document.getElementById('flux-timeline');
    if (!el) return;
    const host = el.closest('.flux-overlay') || el.parentElement;
    if (!host) return;
    pill = document.createElement('button');
    pill.className = 'scroll-to-bottom-pill';
    pill.setAttribute('aria-label', 'Scroll to bottom');
    pill.innerHTML =
      '<span class="scroll-pill-badge" aria-hidden="true"></span>' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
        '<path d="M8 3v8.5M4 8l4 4.5L12 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    pill.style.position = 'absolute';
    pill.style.bottom = '96px'; // above the input bar
    pill.style.right = '24px';
    badge = pill.querySelector('.scroll-pill-badge');
    pill.addEventListener('click', () => {
      latched = true;
      hasNew = false;
      hidePill();
      el.scrollTop = el.scrollHeight;
    });
    host.appendChild(pill);
    el.addEventListener('scroll', onScroll, { passive: true });
  }

  function onScroll() {
    if (!el) return;
    latched = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM;
    if (latched) {
      hasNew = false;
      hidePill();
    } else {
      showPill();
    }
  }

  function showPill() {
    if (pill) {
      pill.classList.add('visible');
      if (badge) badge.classList.toggle('active', hasNew);
    }
  }
  function hidePill() {
    if (pill) {
      pill.classList.remove('visible');
      if (badge) badge.classList.remove('active');
    }
  }

  /** Call on every append: follow when latched, badge when reading. */
  function tick() {
    if (!el) return;
    if (latched) {
      el.scrollTop = el.scrollHeight;
    } else {
      hasNew = true;
      showPill();
    }
  }

  function teardown() {
    if (el) el.removeEventListener('scroll', onScroll);
    if (pill) pill.remove();
    el = null; pill = null; badge = null;
  }

  return { setup, tick, teardown };
})();

// ---------------------------------------------------------------------------
// Mount / teardown
// ---------------------------------------------------------------------------

async function startFluxOverlay(convId) {
  if (overlayActive) return;
  // Start FIRST — a refusal (already active elsewhere) surfaces before
  // any UI mounts.
  try {
    const res = await fetch('/api/flux/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: convId }),
    });
    const data = await res.json();
    if (!data.ok) {
      // One instance is correct — a second Ego must not start. But the
      // interface must never lock the user out: ATTACH to the running
      // Flux State's host conversation instead of refusing entry (the
      // "can't get back in" gap).
      try {
        const st = await fetch('/api/flux/status').then((r) => r.json());
        if (st.hostConversationId) {
          showToast(
            'Flux is active in "' + (st.hostTitle || 'its conversation') +
              '" — attaching there.',
          );
          convId = st.hostConversationId;
        } else {
          showToast(
            data.message || 'Flux could not start.',
          );
          return;
        }
      } catch (e) {
        showToast(data.message || 'Flux could not start.');
        return;
      }
    }
  } catch (e) {
    console.error('flux start failed', e);
    return;
  }

  try {
    const res = await fetch('/fragments/flux/' + encodeURIComponent(convId));
    if (!res.ok) {
      showToast('Flux overlay failed to load.');
      return;
    }
    const html = await res.text();
    // Config-peek from raw HTML BEFORE mounting (voice pattern): a temp
    // div parses the markup without executing anything.
    const peek = document.createElement('div');
    peek.innerHTML = html;
    const cfgEl = peek.querySelector('#flux-config');
    const overlayCfgEl = peek.querySelector('#flux-overlay-cfg');
    if (!cfgEl || !overlayCfgEl) {
      console.error('flux fragment missing config tags');
      return;
    }
    const cfg = JSON.parse(decodeEntities(cfgEl.textContent));
    const overlayCfg = JSON.parse(decodeEntities(overlayCfgEl.textContent));
    conversationId = cfg.conversationId;

    // Mount into the CONVERSATION REGION (.main): the top bar stays
    // visible and the sidebar stays openable while Flux is up.
    const main = document.querySelector('.main') || document.body;
    while (peek.firstChild) main.appendChild(peek.firstChild);

    overlayActive = true;
    thinkingCard = null;
    generatingEl = null;
    stopArmed = false;
    FluxScroll.setup();
    expose(cfg);

    wireOverlay(cfg, overlayCfg);
  } catch (e) {
    console.error('flux overlay mount failed', e);
    cleanup();
  }
}

function wireOverlay(cfg, overlayCfg) {
  const timeline = document.getElementById('flux-timeline');
  const input = document.getElementById('flux-input');
  const sendBtn = document.getElementById('flux-send');

  // Input: auto-grow; Enter sends, Shift+Enter newlines (classic chat
  // convention — same as the standalone page).
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height =
      Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener('click', sendMessage);

  // Initial paint from the fragment's config (mood, organs) + fetch the
  // timeline immediately so the overlay isn't empty until first event.
  if (overlayCfg.moodState) renderMoodStrip(overlayCfg.moodState);
  if (overlayCfg.organHealth) renderOrganHealth(overlayCfg.organHealth);
  loadTimeline();
  input.focus();

  // Status poll drives badge + control states.
  fetchStatus();
  pollTimer = setInterval(fetchStatus, 4000);

  // Dedicated SSE connection (the standalone page's own-connection
  // pattern; closed in cleanup).
  es = new EventSource('/api/events');
  es.addEventListener('flux_entry', function (e) {
    try {
      const entry = JSON.parse(e.data);
      if (entry.kind && !entry.role) {
        if (entry.kind === 'ego' || entry.kind === 'user') {
          finalizeThinkingCard();
        }
        appendSessionEntry(entry);
      } else {
        if (entry.role === 'entity') finalizeThinkingCard();
        appendEntry(entry);
      }
    } catch (err) {}
  });
  es.addEventListener('flux_generating', function () {
    try { finalizeThinkingCard(); showGenerating(); } catch (err) {}
  });
  // ONE live Ego bubble, classic-chat shaped: the hand-rolled
  // pill/span streamers render one-word-per-line with oversize fonts
  // and message-above-thinking; classic structure just works.
  // Structure mirrors classic chat's assistant message: header, thinking
  // section (open while thinking, collapses when words arrive), content.
  // The durable entry (appendSessionEntry kind=ego) replaces it on arrival.
  function ensureLiveEgo() {
    if (liveEgo && liveEgo.el && liveEgo.el.isConnected) return liveEgo;
    const el = document.createElement('div');
    el.className = 'flux-entry entity live-ego';
    // Stamped so ordered inserts (tool cards) place BELOW the streaming
    // bubble — an unstamped element is skipped by the insert walk and
    // cards land above the live stream.
    el.dataset.ts = String(Date.now());
    el.innerHTML =
      '<div class="msg-header"><span>' + escapeHtml(cfg.entityName || 'entity') + '</span><span></span></div>' +
      '<div class="thinking expanded live-thinking">' +
        '<div class="thinking-header"><span class="thinking-toggle">▼</span><span>Thinking</span></div>' +
        '<div class="thinking-content"></div>' +
      '</div>' +
      '<div class="msg-content"></div>';
    timeline.appendChild(el);
    FluxScroll.tick();
    liveEgo = { el, raw: '' };
    return liveEgo;
  }

  es.addEventListener('flux_generating', function () {
    try { ensureLiveEgo(); } catch (err) {}
  });

  es.addEventListener('flux_ego_thinking', function (e) {
    try {
      const data = JSON.parse(e.data);
      const live = ensureLiveEgo();
      const t = live.el.querySelector('.thinking-content');
      if (t) t.textContent += data.fragment || '';
      FluxScroll.tick();
    } catch (err) {}
  });

  es.addEventListener('flux_ego_stream', function (e) {
    try {
      const data = JSON.parse(e.data);
      const live = ensureLiveEgo();
      live.raw += data.fragment || '';
      // Markdown per fragment — classic parity: the live stream renders
      // the same marked+DOMPurify output as the final entry, not plain
      // text that snaps to markdown on completion.
      const c = live.el.querySelector('.msg-content');
      if (c) c.innerHTML = renderMd(live.raw.replace(/<t>[^<]*<\/t>\s*/g, ''));
      // Words arriving = thinking is done; collapse it (classic pattern).
      const th = live.el.querySelector('.live-thinking');
      if (th) th.classList.remove('expanded');
      FluxScroll.tick();
    } catch (err) {}
  });

  es.addEventListener('flux_tool_call', function (e) {
    try {
      const data = JSON.parse(e.data);
      appendToolCall(data);
    } catch (err) {}
  });
  es.addEventListener('flux_turn_done', function () {
    // Converge on the durable interleaved order: the live bubble merges
    // thinking+message above the tool cards; the split entries carry the
    // true per-piece order. Teardown + reload, cheap and rare.
    try {
      if (liveEgo && liveEgo.el) liveEgo.el.remove();
      liveEgo = null;
      hideGenerating();
      loadTimeline();
    } catch (err) {}
  });
  es.addEventListener('flux_tool_result', function (e) {
    try {
      const data = JSON.parse(e.data);
      fillToolResult(data.toolCallId, data.result, data.isError);
      FluxScroll.tick();
    } catch (err) {}
  });
  es.addEventListener('flux_organ_health', function (e) {
    try {
      const data = JSON.parse(e.data);
      if (data.organs) renderOrganHealth(data.organs);
    } catch (err) {}
  });
  // Mode badge: at-a-glance posture.
  es.addEventListener('flux_mode', function (e) {
    try { setModeBadge(JSON.parse(e.data).mode); } catch (err) {}
  });
  fetch('/api/flux/status')
    .then(function (r) { return r.json(); })
    .then(function (st) { setModeBadge(st.sensoryMode); })
    .catch(function () {});
}


function setModeBadge(mode) {
  var el = document.getElementById('flux-mode-badge');
  if (!el) {
    var row = document.createElement('div');
    row.id = 'flux-mode-row';
    row.style.cssText = 'display:flex;justify-content:flex-end;padding:4px 20px 0';
    el = document.createElement('span');
    el.id = 'flux-mode-badge';
    row.appendChild(el);
    var strip = document.getElementById('flux-organ-health');
    if (strip && strip.parentNode) strip.parentNode.insertBefore(row, strip);
    else return;
  }
  const modeRow = document.getElementById('flux-mode-row');
  if (mode) {
    el.textContent = 'mode: ' + mode;
    el.style.cssText = 'display:inline-block;font-size:11px;color:#8b8f99;border:1px solid #2a2e36;border-radius:10px;padding:2px 10px' +
      (mode === 'sleep' ? ';color:#7c8cf8;border-color:#3d46a8' : '');
    if (modeRow) modeRow.style.display = '';
  } else {
    el.style.display = 'none';
    // No mode = no row: an empty band of padding above the organ bar.
    if (modeRow) modeRow.style.display = 'none';
  }
}

function cleanup() {
  overlayActive = false;
  FluxScroll.teardown();
  if (es) { try { es.close(); } catch (e) {} es = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (stopDisarmTimer) { clearTimeout(stopDisarmTimer); stopDisarmTimer = null; }
  thinkingCard = null;
  generatingEl = null;
  stopArmed = false;
  const overlay = document.getElementById('flux-overlay');
  if (overlay) overlay.remove();
  const toast = document.getElementById('flux-toast');
  if (toast) toast.remove();
  document.querySelectorAll('#flux-config, #flux-overlay-cfg').forEach(function (el) {
    el.remove();
  });
  // Pull-refresh back into the thread (voice pattern): the conversation
  // view re-renders with everything the session wrote.
  const conv = conversationId;
  conversationId = null;
  if (conv && window.Psycheros?.selectConversation) {
    window.Psycheros.selectConversation(conv);
  }
}

// ---------------------------------------------------------------------------
// Controls — double-tap stop (the daemon-stop safety pattern)
// ---------------------------------------------------------------------------

function disarmStop() {
  stopArmed = false;
  const btn = document.getElementById('flux-btn-stop');
  if (btn) { btn.textContent = 'Stop'; btn.classList.remove('stop-armed'); }
  if (stopDisarmTimer) { clearTimeout(stopDisarmTimer); stopDisarmTimer = null; }
}

window.fluxOverlayControl = async function (action) {
  if (action === 'pause' || action === 'stop') {
    // No-op when already stopped (first mount, or post-stop).
    const s = await fetch('/api/flux/status').then((r) => r.json()).catch(() => null);
    if (!s || s.state === 'stopped') return;
  }
  if (action === 'pause') {
    disarmStop();
    const s = await fetch('/api/flux/status').then((r) => r.json()).catch(() => null);
    if (s && s.state === 'paused') {
      // Resume: a bare start on the SAME host (the mount's conversation
      // is where it's attached) takes the resume path.
      await fetch('/api/flux/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: conversationId }),
      });
    } else {
      await fetch('/api/flux/pause', { method: 'POST' });
    }
    fetchStatus();
    return;
  }
  if (action === 'stop') {
    const btn = document.getElementById('flux-btn-stop');
    if (!stopArmed) {
      // First tap arms only — never armed at mount.
      stopArmed = true;
      if (btn) { btn.textContent = 'Tap again to stop'; btn.classList.add('stop-armed'); }
      stopDisarmTimer = setTimeout(disarmStop, 3000);
      return;
    }
    disarmStop();
    try {
      await fetch('/api/flux/stop', { method: 'POST' });
    } catch (e) {
      console.error('flux stop failed', e);
    }
    // STAY IN THE TIMELINE: stopping Flux is
    // not leaving the room. The rendered log stays; input disables; the
    // Close button still exits (and pull-refreshes the conversation so
    // the session's dialogue shows in the thread).
    fluxStoppedInView();
    return;
  }
};

/** Post-stop in-place state: the timeline stays readable, the input
 * stands down. A hard refresh (or Close) returns to the conversation. */
function fluxStoppedInView() {
  const input = document.getElementById('flux-input');
  const sendBtn = document.getElementById('flux-send');
  const btn = document.getElementById('flux-stop-btn');
  if (input) {
    input.disabled = true;
    input.placeholder = 'Flux is stopped — close the timeline or start Flux again to talk.';
  }
  if (sendBtn) sendBtn.disabled = true;
  if (btn) {
    btn.textContent = 'stopped';
    btn.classList.remove('stop-armed');
    btn.disabled = true;
  }
}

window.closeFluxOverlay = function () {
  // Leave flux RUNNING, just close the interface (the undercurrent
  // continues; the indicator on the conversation list shows it).
  cleanup();
};

// ---------------------------------------------------------------------------
// Status / initial timeline
// ---------------------------------------------------------------------------

async function fetchStatus() {
  try {
    const d = await fetch('/api/flux/status').then((r) => r.json());
    if (d.moodState) renderMoodStrip(d.moodState);
    if (d.organHealth) renderOrganHealth(d.organHealth);
    const state = d.state || (d.active ? 'running' : 'stopped');
    const badge = document.getElementById('flux-badge');
    if (badge) {
      badge.textContent =
        state === 'running' ? 'Running' : state === 'paused' ? 'Paused' : 'Stopped';
      badge.className = 'flux-badge ' + state;
    }
    const btnStop = document.getElementById('flux-btn-stop');
    // No pause button: user-facing
    // power is binary. A paused State re-attached in the overlay
    // resumes through the drawer's Flux row (turn on = resume).
    if (btnStop) btnStop.disabled = false;
    if (state === 'stopped') disarmStop();
  } catch (e) {}
}

async function loadTimeline() {
  try {
    const results = await Promise.all([
      fetch('/api/flux/entries?limit=50').then((r) => r.json()),
      fetch('/api/flux/session').then((r) => r.json()),
    ]);
    const durable = Array.isArray(results[0]) ? results[0] : [];
    const session = Array.isArray(results[1]) ? results[1] : [];
    const merged = [];
    const stripT = function (s) {
      return (s || '').replace(/<t>[^<]*<\/t>\s*/g, '').slice(0, 80);
    };
    const hasMessageDialogue = session.some(function (e) { return e.fromMessages; });
    const messagePrefixes = {};
    session.forEach(function (e) {
      if (e.fromMessages && (e.kind === 'user' || e.kind === 'ego' || e.kind === 'system')) {
        messagePrefixes[stripT(e.content)] = true;
      }
    });
    const generatedPrefixes = {};
    session.forEach(function (e) {
      if (e.kind === 'briefing' && e.generated) generatedPrefixes[stripT(e.content)] = true;
    });
    const durableContents = {};
    durable.forEach(function (e) {
      const pref = stripT(e.content);
      if (generatedPrefixes[pref]) return;
      if (hasMessageDialogue && (e.role === 'user' || e.role === 'entity')) return;
      durableContents[pref] = true;
      merged.push({ ts: e.timestamp, render: function () { appendEntry(e); } });
    });
    session.forEach(function (e) {
      if (e.source === 'existing-open') return;
      var pref = stripT(e.content);
      if (e.kind === 'briefing' && durableContents[pref]) return;
      if (e.kind === 'briefing' && !e.generated && generatedPrefixes[pref]) return;
      // ONE source of truth per piece, no coverage windows (the window
      // heuristic eats later turns' rows): session user/system
      // rows are copies (record rows render); session EGO rows are the
      // timeline's truth — split pieces for new turns, copies for
      // history — and record ego rows never render here. EXCEPT: the
      // session log clears on every clean stop, so after a
      // stop+restart the log holds no ego pieces at all and the record
      // rows are the ONLY surviving copy — without this fallback the
      // entity's entire prior history vanishes from the timeline (the
      // "previous ego messages don't load" failure).
      var hasSessionEgo = session.some(function (se) {
        return !se.fromMessages && se.kind === 'ego';
      });
      if (!e.fromMessages && hasMessageDialogue &&
          (e.kind === 'user' || e.kind === 'system')) return;
      if (e.fromMessages && e.kind === 'ego' && hasSessionEgo) return;
      merged.push({ ts: e.timestamp, render: function () { appendSessionEntry(e); } });
    });
    merged.sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
    // Full render, not append: flux_turn_done re-runs this load.
    // getElementById — `timeline` is wireOverlay-scoped and reading it
    // here THREW, killing the whole load (the empty-timeline bug).
    var tl = document.getElementById('flux-timeline');
    if (tl) tl.innerHTML = '';
    merged.slice(-60).forEach(function (m) { m.render(); });
  } catch (e) {
    console.error('flux timeline load failed', e);
  }
}


// ---------------------------------------------------------------------------
// Message editing — classic's machinery (PUT /api/messages/:id against the
// host conversation's rows; the record IS the messages table). Reuses
// classic's .msg-edit-btn / .msg-edit-container styles.
// ---------------------------------------------------------------------------
function attachEditButton(div, messageId) {
  if (!messageId || div.querySelector('.msg-edit-btn')) return;
  div.setAttribute('data-message-id', messageId);
  div.style.position = 'relative';
  const btn = document.createElement('button');
  btn.className = 'msg-edit-btn';
  btn.title = 'Edit message';
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  btn.onclick = () => startFluxMessageEdit(div, messageId);
  div.appendChild(btn);
}

function startFluxMessageEdit(div, messageId) {
  if (div.querySelector('.msg-edit-container')) return;
  const contentEl = div.querySelector('.flux-entry-text') || div;
  const original = div.dataset.rawContent || contentEl.textContent || '';
  div.dataset.originalContent = original;
  contentEl.style.display = 'none';
  const editBtn = div.querySelector('.msg-edit-btn');
  if (editBtn) editBtn.style.display = 'none';

  const container = document.createElement('div');
  container.className = 'msg-edit-container';
  const textarea = document.createElement('textarea');
  textarea.className = 'msg-edit-textarea';
  textarea.value = original;
  textarea.rows = Math.min(10, Math.max(3, original.split('\n').length + 1));
  const actions = document.createElement('div');
  actions.className = 'msg-edit-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn btn--ghost btn--sm';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => {
    container.remove();
    contentEl.style.display = '';
    if (editBtn) editBtn.style.display = '';
  };
  const save = document.createElement('button');
  save.className = 'btn btn--primary btn--sm';
  save.textContent = 'Save';
  save.onclick = async () => {
    try {
      const res = await fetch('/api/messages/' + messageId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: textarea.value,
          conversationId: conversationId,
        }),
      });
      if (!res.ok) throw new Error('save failed');
      div.dataset.rawContent = textarea.value;
      if (contentEl !== div) {
        contentEl.innerHTML = renderMd(textarea.value);
      }
      container.remove();
      contentEl.style.display = '';
      if (editBtn) editBtn.style.display = '';
    } catch (e) {
      console.error('flux message edit failed', e);
      save.textContent = 'Failed';
      setTimeout(() => (save.textContent = 'Save'), 1500);
    }
  };
  actions.appendChild(cancel);
  actions.appendChild(save);
  container.appendChild(textarea);
  container.appendChild(actions);
  contentEl.after(container);
  textarea.focus();
}

// ---------------------------------------------------------------------------
// Rendering (ported from the standalone page)
// ---------------------------------------------------------------------------

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// <script> elements are RAW-TEXT in HTML — entities inside them are
// never decoded by the parser, so JSON in a config tag arrives with
// &quot; &amp; etc. intact (the silent-death bug on the first overlay
// mount; voice.js has the same latent issue, masked
// by its API fallback). Decode before JSON.parse.
function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function renderMd(text) {
  try {
    return DOMPurify.sanitize(marked.parse(text || ''));
  } catch (e) {
    return escapeHtml(text || '');
  }
}

// Retire the streamed thinking card when the real entry arrives — the
// entry carries the same thinking as its own collapsible block, so
// keeping the card double-rendered every turn.
function finalizeThinkingCard() {
  if (thinkingCard && !thinkingCard.closed) {
    thinkingCard.closed = true;
    const wrap = thinkingCard.closest('.flux-entry');
    if (wrap) wrap.remove();
    thinkingCard = null;
  }
}

function showGenerating() {
  hideGenerating();
  generatingEl = document.createElement('div');
  generatingEl.className = 'flux-generating';
  generatingEl.dataset.ts = String(Date.now()); // ordered inserts below it
  // One block-level text node — mirrors the durable entry's shape (the
  // two-span pill renders one word per line during streaming).
  generatingEl.innerHTML = '<div class="flux-gen-text"></div>';
  const timeline = document.getElementById('flux-timeline');
  timeline.appendChild(generatingEl);
  FluxScroll.tick();
}
function hideGenerating() {
  if (generatingEl) { generatingEl.remove(); generatingEl = null; }
  if (typeof liveEgo !== 'undefined' && liveEgo && liveEgo.el) {
    liveEgo.el.remove();
    liveEgo = null;
  }
}


/** Append a timeline entry in TIMESTAMP order: live
 * entries arrive by write-time, but the split thinking entry is
 * timestamped when the thinking happened — older than cards already on
 * the timeline. Append when newest; otherwise insert before the first
 * newer card so the live view matches the durable (reload) order. */
function addToTimeline(div, tsIso) {
  const timeline = document.getElementById('flux-timeline');
  if (!timeline) return;
  const ts = Date.parse(tsIso || '') || 0;
  div.dataset.ts = String(ts);
  const kids = timeline.children;
  for (let i = kids.length - 1; i >= 0; i--) {
    const k = Number(kids[i].dataset && kids[i].dataset.ts || 0);
    if (k && k <= ts) {
      kids[i].insertAdjacentElement('afterend', div);
      return;
    }
  }
  timeline.insertBefore(div, timeline.firstChild);
}

function appendEntry(entry) {
  hideGenerating();
  const timeline = document.getElementById('flux-timeline');
  const div = document.createElement('div');
  const organId = entry.metadata && entry.metadata.organId;
  const isReverie = entry.role === 'ambient' && organId === 'reverie';
  const isMusing = entry.role === 'ambient' && organId === 'musing';
  const isDream = entry.role === 'ambient' && organId === 'dream';
  const isCompaction = entry.role === 'ambient' &&
    String(entry.metadata?.source || '').indexOf('compaction') === 0;
  let cls = 'flux-entry ' + (entry.role === 'user'
    ? 'user'
    : entry.role === 'entity'
    ? 'entity'
    : 'ambient');
  if (entry.role === 'ambient') {
    if (isCompaction) cls += ' compaction';
    else if (isDream) cls += ' dream';
    else if (isReverie) cls += ' reverie';
    else if (isMusing) cls += ' musing';
    else cls += ' noticing';
    if (entry.metadata?.escalated) cls += ' escalated';
  }
  div.className = cls;
  // Module label — same mapping as the session renderer and the
  // standalone page. Durable rows carry the ORGAN id (motion-vision,
  // musing, reverie); the label shows the MODULE (Noticing/Musing/
  // Reverie/Dream/Compaction), capitalized, so the timeline is
  // consistent across surfaces.
  const src = String(
    (entry.metadata && (entry.metadata.source || entry.metadata.organId)) ||
      organId || '',
  );
  const mod = src.indexOf('compaction') === 0 ? 'Compaction'
    : src === 'musing' ? 'Musing'
    : src === 'reverie' ? 'Reverie'
    : src === 'dream' ? 'Dream'
    : src === 'thalamus' ? 'system'
    : 'Noticing';
  div.innerHTML = escapeHtml(entry.content || '') +
    '<div class="meta">' + mod + ' · ' + fmtTime(entry.timestamp) + '</div>';
  addToTimeline(div, entry.timestamp);
  FluxScroll.tick();
}

function appendSessionEntry(e) {
  hideGenerating();
  const timeline = document.getElementById('flux-timeline');
  const cfg = window.__fluxCfg || {};
  const div = document.createElement('div');
  if (e.kind === 'tool_use') {
    div.className = 'flux-entry tool-wrap';
    if (e.id) div.dataset.toolCallId = e.id;
    div.innerHTML =
      '<div class="tool">' +
        '<div class="tool-header">' +
          '<span class="tool-icon">&#9881;</span>' +
          '<span class="tool-name">' + escapeHtml(e.source || 'tool') + '</span>' +
          '<span class="tool-toggle">&#9660;</span>' +
        '</div>' +
        '<div class="tool-args">' + escapeHtml(e.content || '') + '</div>' +
        '<div class="tool-result"></div>' +
      '</div>';
    const header = div.querySelector('.tool-header');
    if (header) {
      header.addEventListener('click', function () {
        const card = this.parentElement;
        if (card) card.classList.toggle('expanded');
      });
    }
  } else if (e.kind === 'tool_result') {
    // Reload merging: the result entry's id is `<callId>-result` — fill
    // the matching card instead of stacking a second one. A missing
    // card (entry cap trimmed it) still shows a small standalone note.
    const callId = (e.id || '').replace(/-result$/, '');
    if (callId && fillToolResult(callId, e.content, false)) {
      FluxScroll.tick();
      return;
    }
    div.className = 'flux-entry tool-wrap';
    div.innerHTML =
      '<div class="tool">' +
        '<div class="tool-header">' +
          '<span class="tool-icon">&#9881;</span>' +
          '<span class="tool-name">' + escapeHtml(e.source || 'tool') + ' · result</span>' +
          '<span class="tool-toggle">&#9660;</span>' +
        '</div>' +
        '<div class="tool-result">' + escapeHtml(e.content || '') + '</div>' +
      '</div>';
    const header = div.querySelector('.tool-header');
    if (header) {
      header.addEventListener('click', function () {
        const card = this.parentElement;
        if (card) card.classList.toggle('expanded');
      });
    }
  } else if (e.kind === 'ego') {
    div.className = 'flux-entry entity';
    const stripped = (e.content || '').replace(/<t>[^<]*<\/t>\s*/g, '');
    let body = '';
    if (e.thinking) {
      body += '<details class="thinking-details" style="margin-bottom:6px;">' +
        '<summary style="cursor:pointer;opacity:0.6;font-size:12px;">thinking</summary>' +
        '<div style="opacity:0.75;font-size:13px;white-space:pre-wrap;border-left:2px solid var(--c-border);padding-left:8px;margin-top:4px;">' +
        escapeHtml(e.thinking) + '</div></details>';
    }
    if (!stripped.trim()) {
      // Thinking-only entry (the split turn-thinking card): the
      // collapsible details above IS the bubble — no expanded-text
      // fallback (it refuses to collapse).
    } else {
      body += '<div class="flux-entry-text">' + renderMd(stripped) + '</div>';
    }
    div.innerHTML = body +
      '<div class="meta">' + escapeHtml(window.__fluxEntityName || 'entity') + ' · ' + fmtTime(e.timestamp) + '</div>';
    const editId = e.messageId || e.id;
    if (editId) {
      div.dataset.rawContent = stripped;
      attachEditButton(div, editId);
    }
  } else if (e.kind === 'briefing') {
    const s = e.source || '';
    const mod = s.indexOf('compaction') === 0 ? 'Compaction'
      : s.indexOf('reverie') >= 0 ? 'Reverie'
      : s.indexOf('musing') >= 0 ? 'Musing'
      : 'Noticing';
    let cls = 'flux-entry ambient';
    if (s.indexOf('compaction') === 0) cls += ' compaction';
    else if (s.indexOf('reverie') >= 0) cls += ' reverie';
    else if (s.indexOf('musing') >= 0) cls += ' musing';
    else cls += ' noticing';
    if (e.generated) cls += ' escalated';
    div.className = cls;
    div.innerHTML = escapeHtml(e.content) +
      '<div class="meta">' + mod + ' · ' + fmtTime(e.timestamp) + '</div>';
  } else if (e.kind === 'system') {
    div.className = 'flux-entry ambient';
    div.innerHTML = escapeHtml(e.content) +
      '<div class="meta">system · ' + fmtTime(e.timestamp) + '</div>';
  } else {
    div.className = 'flux-entry user';
    div.innerHTML = '<div class="flux-entry-text">' + renderMd(e.content || '') + '</div>' +
      '<div class="meta">' + escapeHtml(window.__fluxUserName || 'user') + ' · ' + fmtTime(e.timestamp) + '</div>';
    const editId = e.messageId || e.id;
    if (editId) {
      div.dataset.rawContent = e.content || '';
      attachEditButton(div, editId);
    }
  }
  addToTimeline(div, e.timestamp);
  FluxScroll.tick();
}

function appendToolCall(data) {
  const timeline = document.getElementById('flux-timeline');
  const div = document.createElement('div');
  div.className = 'flux-entry tool-wrap';
  // Keyed by toolCallId so the later flux_tool_result event (and reload
  // merging, appendSessionEntry) fills THIS card's result — one card per
  // call, args + result, like classic chat's tool cards.
  if (data.toolCallId) div.dataset.toolCallId = data.toolCallId;
  let formattedArgs = data.args;
  try { formattedArgs = JSON.stringify(JSON.parse(data.args), null, 2); } catch (ex) {}
  // Collapsed by default like classic's persisted cards (space
  // saving, the thinking-block treatment); header
  // click toggles.
  div.innerHTML =
    '<div class="tool">' +
      '<div class="tool-header">' +
        '<span class="tool-icon">&#9881;</span>' +
        '<span class="tool-name">' + escapeHtml(data.name) + '</span>' +
        '<span class="tool-toggle">&#9660;</span>' +
      '</div>' +
      '<div class="tool-args">' + escapeHtml(formattedArgs || '') + '</div>' +
      '<div class="tool-result' + (data.isError ? ' error' : '') + '">' +
        escapeHtml(data.result || '') +
      '</div>' +
    '</div>';
  const header = div.querySelector('.tool-header');
  if (header) {
    header.addEventListener('click', function () {
      const card = this.parentElement;
      if (card) card.classList.toggle('expanded');
    });
  }
  addToTimeline(div, data.timestamp || new Date().toISOString());
  FluxScroll.tick();
}

/** Fill a tool card's result slot (live flux_tool_result events and
 * reload-time tool_result entry merging share this). Silent fill — the
 * card stays in its current collapse state (space saving). */
function fillToolResult(callId, result, isError) {
  const card = document.querySelector(
    '.tool-wrap[data-tool-call-id="' + (callId || '') + '"]'
  );
  if (!card) return false;
  const slot = card.querySelector('.tool-result');
  if (slot) {
    slot.textContent = result || '';
    slot.classList.toggle('error', !!isError);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mood strip + organ health (ported)
// ---------------------------------------------------------------------------

// PAD only — the connection axis is temporarily dropped.
const MOOD_AXES = ['valence', 'arousal', 'dominance'];
const MOOD_LABELS = {
  valence: 'Valence', arousal: 'Arousal', dominance: 'Dominance',
};
const MOOD_QUAL = {
  valence: (v) => (v > 0.1 ? 'positive' : v < -0.1 ? 'negative' : 'neutral'),
  arousal: (v) => (v > 0.1 ? 'alert' : v < -0.1 ? 'calm' : 'neutral'),
  dominance: (v) => (v > 0.1 ? 'in control' : v < -0.1 ? 'adrift' : 'neutral'),
};
function moodColor(v) {
  if (v > 0.05) return 'var(--c-success)';
  if (v < -0.05) return 'var(--c-highlight)';
  return 'var(--c-fg-subtle)';
}

function renderMoodStrip(state) {
  const strip = document.getElementById('flux-mood-strip');
  if (!strip || !state) return;
  strip.innerHTML = MOOD_AXES.map(function (axis) {
    const v = state[axis] || 0;
    const abs = Math.abs(v);
    const widthPct = abs * 50;
    const left = v >= 0 ? '50%' : (50 - widthPct) + '%';
    return '<div class="mood-axis">' +
      '<span class="mood-axis-label">' + MOOD_LABELS[axis] + '</span>' +
      '<div class="mood-axis-row">' +
        '<div class="mood-axis-bar">' +
          '<div class="mood-axis-fill" style="left:' + left + '; width:' + widthPct + '%; background:' + moodColor(v) + ';"></div>' +
        '</div>' +
        '<span class="mood-axis-value">' + (v >= 0 ? '+' : '') + v.toFixed(2) + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderOrganHealth(organs) {
  const el = document.getElementById('flux-organ-health');
  if (!el) return;
  if (!organs || !organs.length) { el.innerHTML = ''; return; }
  el.innerHTML = organs.map(function (o) {
    const st = o.health && o.health.state ? o.health.state : 'green';
    const title = o.health && o.health.detail
      ? o.organId + ' — ' + o.health.detail
      : o.organId;
    return '<span class="organ-health-item" title="' + escapeHtml(title) + '">' +
      '<span class="organ-health-dot ' + st + '"></span>' +
      escapeHtml(o.organId) +
    '</span>';
  }).join('');
}

// ---------------------------------------------------------------------------
// Message send
// ---------------------------------------------------------------------------

function sendMessage() {
  const input = document.getElementById('flux-input');
  const sendBtn = document.getElementById('flux-send');
  const content = input.value.trim();
  if (!content) return;
  sendBtn.disabled = true;
  fetch('/api/flux/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content }),
  }).then(function () {
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = false;
    input.focus();
  }).catch(function () { sendBtn.disabled = false; });
}

// Expose names + config for inline handlers (the fragment's buttons use
// onclick= which needs global scope). The FUNCTION must be exposed at
// module load — not at mount: psycheros.js's FAB handler guards on its
// existence before the first mount ever happens (the bootstrapping
// deadlock that produced "Flux interface not loaded" on first click).
// The name/user config still arrives with the mount.
window.startFluxOverlayFn = startFluxOverlay;

function expose(cfg) {
  window.__fluxEntityName = cfg.entityName;
  window.__fluxUserName = cfg.userName;
}

export { startFluxOverlay, cleanup };
