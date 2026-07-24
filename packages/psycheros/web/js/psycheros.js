/**
 * Psycheros Client JavaScript
 * Handles SSE streaming, sidebar toggle, input management, and service worker.
 */

// =============================================================================
// Helpers
// =============================================================================

/**
 * Focus the message input only on non-touch (desktop) devices.
 * On touch devices, programmatic focus triggers the on-screen keyboard,
 * which is jarring after message streaming completes or on navigation.
 */
function focusInputWhenReady() {
  if (!('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
    document.getElementById('message-input')?.focus();
  }
}

// =============================================================================
// State
// =============================================================================

let currentConversationId = null;
let isStreaming = false;
let pendingAttachmentId = null;
let pendingAttachmentUrl = null;
const pendingToolCalls = new Map();
let currentAbortController = null;
let streamingConversationId = null; // The conversation currently being streamed (may differ from currentConversationId)
let persistentSSE = null;

// General settings (display names)
globalThis.PsycherosSettings = { entityName: 'Assistant', userName: 'You', timezone: '' };

// Selection mode state
let selectionMode = false;
const selectedConversations = new Set();
let pendingDeleteIds = null;

// Touch/swipe state
const touchState = {
  wrapper: null,
  startX: 0,
  startY: 0,
  currentX: 0,
  isDragging: false,
  longPressTimer: null,
};

// Context inspector state
let contextInspectorOpen = false;
let contextSnapshots = [];
let selectedSnapshotIdx = -1;
let contextSearchQuery = '';

// Tokenizer state
let tokenizer = null;
let tokenizerReady = false;
let tokenizerFailed = false;

// =============================================================================
// Tokenizer
// =============================================================================

const TOKENIZER_RANKS_URL = 'https://tiktoken.pages.dev/js/cl100k_base.json';

/**
 * Estimate tokens using the simple chars/4 heuristic (fallback).
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Count tokens using the loaded tokenizer, or fall back to estimate.
 */
function countTokens(text) {
  if (tokenizerReady && tokenizer) {
    try {
      return tokenizer.encode(text || '').length;
    } catch {
      return estimateTokens(text);
    }
  }
  return estimateTokens(text);
}

/**
 * Initialize the tokenizer by loading js-tiktoken from esm.sh and
 * fetching cl100k_base ranks from tiktoken CDN.
 */
async function initTokenizer() {
  try {
    const { Tiktoken } = await import('https://esm.sh/js-tiktoken@1.0.21/lite');
    const res = await fetch(TOKENIZER_RANKS_URL);
    if (!res.ok) throw new Error(`Failed to fetch ranks: ${res.status}`);
    const ranks = await res.json();
    tokenizer = new Tiktoken(ranks);
    tokenizerReady = true;
    // Re-render if context inspector is open
    renderContextInspector();
    // Update editor token count if visible
    updateEditorTokenCount();
  } catch (e) {
    console.warn('Tokenizer init failed, using estimate:', e);
    tokenizerFailed = true;
  }
}

// Start loading the tokenizer immediately
initTokenizer();

/**
 * Update the token count display in the file editor.
 * If no textarea is passed, finds one from the DOM.
 */
function updateEditorTokenCount(textarea) {
  const el = document.getElementById('settings-editor-tokens');
  if (!el) return;
  const ta = textarea || document.querySelector('[data-tokenize]');
  if (!ta) return;
  const tokens = countTokens(ta.value);
  const label = tokenizerReady ? 'tokens' : 'est. tokens';
  el.textContent = `${tokens.toLocaleString()} ${label}`;
}

// =============================================================================
// Persistent SSE Connection
// =============================================================================

/**
 * Initialize or reconnect the persistent SSE connection.
 * This connection receives DOM updates from background operations.
 */
function initPersistentSSE() {
  // Close existing connection if any
  if (persistentSSE) {
    persistentSSE.close();
    persistentSSE = null;
  }

  // Build URL with optional conversation filter
  const url = currentConversationId
    ? `/api/events?conversationId=${currentConversationId}`
    : '/api/events';

  persistentSSE = new EventSource(url);

  persistentSSE.addEventListener('connected', (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('Persistent SSE connected:', data.clientId);
    } catch (e) {
      console.warn('Failed to parse connected event:', e);
    }
  });

  persistentSSE.addEventListener('dom_update', (event) => {
    try {
      const update = JSON.parse(event.data);
      const target = document.querySelector(update.target);
      if (target) {
        htmx.swap(target, update.html, { swapStyle: update.swap || 'innerHTML' });
        // Auto-scroll when content is appended to messages
        if (update.target === '#messages') {
          AutoScroll.streamTick();
        }
      }
    } catch (e) {
      console.error('Failed to handle dom_update:', e);
    }
  });

  // Pulse streaming state (persistent SSE)
  let pulseAssistantEl = null;
  let pulseContent = null;
  let pulseSegmentRaw = '';
  let pulseThinking = null;
  let pulseStreamed = false;

  persistentSSE.addEventListener('content', (event) => {
    try {
      const data = JSON.parse(event.data);
      // Lazily create the assistant message element on first content
      if (!pulseAssistantEl) {
        const messages = document.getElementById('messages');
        if (!messages) return;
        document.getElementById('empty-state')?.remove();

        // Disable input and show stop button
        enterPulseStreamingMode();
        pulseStreamed = true;

        pulseAssistantEl = document.createElement('div');
        pulseAssistantEl.className = 'msg msg--assistant';
        const streamTime = formatChatTimestamp(new Date());
        pulseAssistantEl.innerHTML = `
          <div class="msg-header">
            <span>${globalThis.PsycherosSettings.entityName || 'Assistant'}</span>
            <span class="msg-timestamp">${streamTime}</span>
            <div class="streaming"><span></span><span></span><span></span></div>
          </div>
          <div class="msg-content"></div>
        `;
        messages.appendChild(pulseAssistantEl);
        AutoScroll.streamStart();
      }
      handleSSEEvent('content', data, pulseAssistantEl, {
        getThinking: () => pulseThinking,
        setThinking: (el) => pulseThinking = el,
        getContent: () => pulseContent,
        setContent: (el) => pulseContent = el,
        getSegmentRaw: () => pulseSegmentRaw,
        setSegmentRaw: (text) => pulseSegmentRaw = text,
        appendSegmentRaw: (text) => pulseSegmentRaw += text,
      });
    } catch (e) {
      console.error('Failed to handle persistent content:', e);
    }
  });

  persistentSSE.addEventListener('thinking', (event) => {
    try {
      if (!pulseAssistantEl) return;
      handleSSEEvent('thinking', JSON.parse(event.data), pulseAssistantEl, {
        getThinking: () => pulseThinking,
        setThinking: (el) => pulseThinking = el,
        getContent: () => pulseContent,
        setContent: (el) => pulseContent = el,
        getSegmentRaw: () => pulseSegmentRaw,
        setSegmentRaw: (text) => pulseSegmentRaw = text,
        appendSegmentRaw: (text) => pulseSegmentRaw += text,
      });
    } catch (e) {
      console.error('Failed to handle persistent thinking:', e);
    }
  });

  persistentSSE.addEventListener('tool_call', (event) => {
    try {
      if (!pulseAssistantEl) return;
      handleSSEEvent('tool_call', event.data, pulseAssistantEl, {
        getThinking: () => pulseThinking,
        setThinking: (el) => pulseThinking = el,
        getContent: () => pulseContent,
        setContent: (el) => pulseContent = el,
        getSegmentRaw: () => pulseSegmentRaw,
        setSegmentRaw: (text) => pulseSegmentRaw = text,
        appendSegmentRaw: (text) => pulseSegmentRaw += text,
      });
    } catch (e) {
      console.error('Failed to handle persistent tool_call:', e);
    }
  });

  persistentSSE.addEventListener('tool_result', (event) => {
    try {
      if (!pulseAssistantEl) return;
      handleSSEEvent('tool_result', event.data, pulseAssistantEl, {
        getThinking: () => pulseThinking,
        setThinking: (el) => pulseThinking = el,
        getContent: () => pulseContent,
        setContent: (el) => pulseContent = el,
        getSegmentRaw: () => pulseSegmentRaw,
        setSegmentRaw: (text) => pulseSegmentRaw = text,
        appendSegmentRaw: (text) => pulseSegmentRaw += text,
      });
    } catch (e) {
      console.error('Failed to handle persistent tool_result:', e);
    }
  });

  persistentSSE.addEventListener('status', (event) => {
    try {
      const status = JSON.parse(event.data);
      if (status.error) {
        // If we have an active assistant element, inject the error there
        if (pulseAssistantEl) {
          handleSSEEvent('status', event.data, pulseAssistantEl, {
            getThinking: () => pulseThinking,
            setThinking: (el) => pulseThinking = el,
            getContent: () => pulseContent,
            setContent: (el) => pulseContent = el,
            getSegmentRaw: () => pulseSegmentRaw,
            setSegmentRaw: (text) => pulseSegmentRaw = text,
            appendSegmentRaw: (text) => pulseSegmentRaw += text,
          });
        } else {
          // No assistant element exists yet — create an error indicator
          // directly in the messages area so the user sees what happened.
          const messages = document.getElementById('messages');
          if (messages) {
            const errorEl = document.createElement('div');
            errorEl.className = 'msg msg--assistant';
            errorEl.innerHTML = `
              <div class="msg-header">
                <span>${globalThis.PsycherosSettings.entityName || 'Assistant'}</span>
              </div>
              <div class="msg-content"></div>
            `;
            const errorText = errorEl.querySelector('.msg-content');
            if (errorText) {
              const statusDiv = document.createElement('div');
              statusDiv.className = 'status error';
              statusDiv.style.color = 'var(--c-error)';
              statusDiv.textContent = status.error;
              errorText.appendChild(statusDiv);
            }
            messages.appendChild(errorEl);
            AutoScroll.jumpToBottom();
          }
        }
      } else if (status.retry) {
        // Transient retry during Pulse streaming
        if (pulseAssistantEl) {
          handleSSEEvent('status', event.data, pulseAssistantEl, {
            getThinking: () => pulseThinking,
            setThinking: (el) => pulseThinking = el,
            getContent: () => pulseContent,
            setContent: (el) => pulseContent = el,
            getSegmentRaw: () => pulseSegmentRaw,
            setSegmentRaw: (text) => pulseSegmentRaw = text,
            appendSegmentRaw: (text) => pulseSegmentRaw += text,
          });
          showToast(status.message, 'warning');
        }
      }
    } catch (e) {
      console.error('Failed to handle persistent status:', e);
    }
  });

  persistentSSE.addEventListener('done', (event) => {
    try {
      if (!pulseAssistantEl) {
        // No assistant element on this connection. If the Pulse was streaming
        // when the old SSE connection was torn down, pulseStreamingPulseId
        // will still be set at module level. The done event on this new
        // connection signals the Pulse finished — exit streaming mode.
        if (pulseStreamingPulseId) {
          pulseStreamingPulseId = null;
          exitPulseStreamingMode();
        }
        return;
      }
      handleSSEEvent('done', event.data, pulseAssistantEl, {
        getThinking: () => pulseThinking,
        setThinking: (el) => pulseThinking = el,
        getContent: () => pulseContent,
        setContent: (el) => pulseContent = el,
        getSegmentRaw: () => pulseSegmentRaw,
        setSegmentRaw: (text) => pulseSegmentRaw = text,
        appendSegmentRaw: (text) => pulseSegmentRaw += text,
      });
      // Reset pulse streaming state (keep pulseStreamed so pulse_complete
      // knows we received the stream and doesn't unnecessarily reload)
      pulseAssistantEl = null;
      pulseContent = null;
      pulseSegmentRaw = '';
      pulseThinking = null;
      pulseStreamingPulseId = null;

      // Re-enable input and restore send button
      exitPulseStreamingMode();
    } catch (e) {
      console.error('Failed to handle persistent done:', e);
    }
  });

  persistentSSE.addEventListener('message_id', (event) => {
    try {
      const { role, id } = JSON.parse(event.data);
      const messages = document.getElementById('messages');
      if (!messages) return;
      if (role === 'user') {
        // Find the last user or pulse message without a data-message-id
        const userMsgs = messages.querySelectorAll('.msg--user:not([data-message-id]), .msg--pulse:not([data-message-id])');
        const lastUserMsg = userMsgs[userMsgs.length - 1];
        if (lastUserMsg) addMessageEditCapability(lastUserMsg, id);
      } else if (role === 'assistant') {
        // pulseAssistantEl is nulled after done, so query the DOM
        const asstMsgs = messages.querySelectorAll('.msg--assistant:not([data-message-id])');
        const lastAsstMsg = asstMsgs[asstMsgs.length - 1];
        if (lastAsstMsg) addMessageEditCapability(lastAsstMsg, id);
      }
    } catch (e) {
      console.error('Failed to handle persistent message_id:', e);
    }
  });

  persistentSSE.addEventListener('pulse_complete', (event) => {
    try {
      const { conversationId } = JSON.parse(event.data);
      // Don't reload the conversation if the user is viewing settings —
      // they'll see the Pulse response when they navigate back to the chat.
      const viewingSettings = document.getElementById('settings-content') !== null;
      if (!pulseStreamed && !pulseAssistantEl && conversationId === currentConversationId && !viewingSettings) {
        // Streaming was missed entirely — reload the conversation to show the response
        loadConversationFromUrl(conversationId, { silent: true });
      }
      pulseStreamed = false;
    } catch (e) {
      console.error('Failed to handle pulse_complete:', e);
    }
  });

  persistentSSE.addEventListener('mcp_status', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.message) {
        if (data.connected && data.alive) {
          showToast(data.message, 'warning');
        } else {
          showToast(data.message, 'warning');
        }
      }
    } catch (e) {
      console.warn('Failed to handle mcp_status:', e);
    }
  });

  persistentSSE.onerror = () => {
    // Don't rely on EventSource built-in reconnect — it can silently get
    // stuck in CONNECTING state. Close explicitly and reconnect ourselves.
    persistentSSE.close();
    persistentSSE = null;
    // Reconnect after a short delay to avoid tight error loops
    setTimeout(initPersistentSSE, 1000);
  };
}

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  }

  // Push notification subscription
  // Automatically subscribes if permission is already granted
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    if (Notification.permission === 'granted') {
      subscribeToPushNotifications();
    }
  }

  // Check if URL has a conversation ID (e.g., /c/abc123)
  const match = globalThis.location.pathname.match(/^\/c\/([^/]+)$/);
  if (match) {
    const conversationId = match[1];
    currentConversationId = conversationId;
    loadConversationFromUrl(conversationId);
  }

  // Initialize persistent SSE connection for background updates
  initPersistentSSE();

  // Reconnect SSE and reload conversation when returning to the app (mobile PWA).
  // Mobile browsers drop EventSource connections when the app is backgrounded,
  // so Pulse messages fired while away are missed. This listener ensures the
  // connection is re-established and any missed messages are fetched on return.
  //
  // The conversation reload is debounced (1500ms) and heavily guarded to avoid
  // destroying the textarea while the user is typing. On Android PWA, the
  // virtual keyboard can trigger spurious visibilitychange events that would
  // otherwise dismiss the keyboard and flash-destroy the input. The SSE is
  // reconnected on every visible event (unless a Pulse is streaming) to
  // prevent stuck CONNECTING states from silently dropping Pulse events.
  let visibilityReloadTimer = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Cancel any pending reload — the page is going away again (e.g. keyboard
      // flicker where hidden→visible→hidden→visible resolves quickly).
      if (visibilityReloadTimer) {
        clearTimeout(visibilityReloadTimer);
        visibilityReloadTimer = null;
      }
      return;
    }

    // visible — reconnect SSE unless a Pulse is actively streaming on this
    // connection. When streaming, tearing down the SSE would lose in-flight
    // content. The pulse_complete fallback reload would recover the data but
    // the real-time experience would be disrupted.
    // A connection stuck in CONNECTING (no active streaming) is dead — the
    // old health check treated CONNECTING as healthy, which is why Pulses
    // stopped appearing until a manual refresh.
    if (!pulseStreamingPulseId) {
      initPersistentSSE();
    }

    // Skip reload entirely when the user is actively interacting:
    //   - No conversation loaded
    //   - Chat or Pulse is actively streaming (DOM is being updated live)
    //   - The message input is focused (user is typing)
    //   - The virtual keyboard is open on mobile (visualViewport shrunk)
    if (!currentConversationId) return;
    if (isStreaming) return;
    if (pulseStreamingPulseId) return;

    const input = document.getElementById('message-input');
    if (input && document.activeElement === input) return;

    // Detect virtual keyboard on mobile: when the keyboard is open,
    // visualViewport.height is less than window.innerHeight
    const vv = window.visualViewport;
    if (vv && vv.height < window.innerHeight * 0.75) return;

    // Debounce the reload: only fire if the page stays visible for 1500ms.
    // Brief visibility flickers (keyboard pop) will be cancelled by the
    // hidden handler above before the timer fires.
    if (visibilityReloadTimer) clearTimeout(visibilityReloadTimer);

    visibilityReloadTimer = setTimeout(() => {
      visibilityReloadTimer = null;

      // Re-check conditions at fire time — state may have changed during debounce
      const viewingSettings = document.getElementById('settings-content') !== null;
      if (viewingSettings) return;
      if (isStreaming) return;
      if (pulseStreamingPulseId) return;

      const inputNow = document.getElementById('message-input');
      if (inputNow && document.activeElement === inputNow) return;
      if (inputNow?.value?.trim()) return;

      const vvNow = window.visualViewport;
      if (vvNow && vvNow.height < window.innerHeight * 0.75) return;

      // Skip reload if the browser reports offline — Android PWA network
      // may not be ready yet after backgrounding. The SSE reconnection will
      // handle catching up once connectivity returns.
      if (!navigator.onLine) return;

      loadConversationFromUrl(currentConversationId, { silent: true });
    }, 1500);
  });

  // Load general settings (display names)
  fetch('/api/general-settings')
    .then(r => r.json())
    .then(data => {
      if (data) {
        window.PsycherosSettings.entityName = data.entityName || 'Assistant';
        window.PsycherosSettings.userName = data.userName || 'You';
        window.PsycherosSettings.timezone = data.timezone || '';
      }
    })
    .catch(() => {});

  // Event delegation for token counting in the file editor textarea
  document.addEventListener('input', (e) => {
    if (e.target.matches('[data-tokenize]')) {
      updateEditorTokenCount(e.target);
    }
  });

  // Initial token count for any editor that may already be loaded
  updateEditorTokenCount();

  // Event delegation for conversation list clicks
  // This avoids inline onclick handlers (XSS prevention)
  document.addEventListener('click', (e) => {
    // Handle checkbox clicks in selection mode
    if (e.target.classList.contains('conv-select-checkbox')) {
      const wrapper = e.target.closest('.conv-item-wrapper');
      if (wrapper) {
        toggleSelection(wrapper);
      }
      return;
    }

    const convItem = e.target.closest('.conv-item[data-conv-id]');
    if (convItem) {
      // In selection mode, toggle selection instead of navigating
      if (selectionMode) {
        e.preventDefault();
        const wrapper = convItem.closest('.conv-item-wrapper');
        if (wrapper) {
          toggleSelection(wrapper);
        }
        return;
      }

      const id = convItem.dataset.convId;
      if (id) {
        e.preventDefault();
        selectConversation(id);
      }
    }
  });

  // Right-click for selection mode (desktop)
  document.addEventListener('contextmenu', (e) => {
    const wrapper = e.target.closest('.conv-item-wrapper');
    if (wrapper) {
      e.preventDefault();
      enterSelectionMode(wrapper);
    }
  });

  // ESC key exits selection mode or closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.querySelector('.modal-backdrop.visible')) {
        closeDeleteModal();
      } else if (selectionMode) {
        exitSelectionMode();
      }
    }
  });

  // Initialize touch handlers for swipe
  initConversationTouchHandlers();

  // Create selection bar and modal containers
  createUIContainers();

  // Initialize smart auto-scroll
  AutoScroll.init();

  // Focus input on load
  const input = document.getElementById('message-input');
  if (input) {
    // Restore any saved draft for the initial view (home or direct /c/:id URL).
    // Direct /c/:id URLs also call restoreDraft() from loadConversationFromUrl,
    // but that runs before the message-input is in the DOM; this runs after.
    restoreDraft();
    input.focus();
  }

  // Scroll to bottom when chat content is swapped via HTMX (sidebar clicks)
  document.body.addEventListener('htmx:afterSwap', (e) => {
    const targetId = e.detail.target?.id;
    if (targetId === 'chat') {
      AutoScroll.reinit();
      if (document.getElementById('load-earlier-sentinel') && currentConversationId) {
        LazyLoader.init(currentConversationId);
      } else {
        LazyLoader.cleanup();
      }
      requestAnimationFrame(() => AutoScroll.jumpToBottom());
      // Re-restore draft after any HTMX-driven #chat swap (e.g. HTMX-SSE
      // auto-refresh) — the swap resets the textarea, so without this the
      // saved draft would be lost. saveDraft on every keystroke keeps
      // localStorage current; we don't need a matching beforeSwap save.
      restoreDraft();
    }

    // Initialize graph view if present in chat or settings-content
    if ((targetId === 'chat' || targetId === 'settings-content') && document.getElementById('graph-container')) {
      loadGraphView();
    }

    // Discord Hub: re-trigger channel picker loading on HTMX re-swap.
    // The inline script may not re-execute on subsequent swaps.
    if (targetId === 'chat' && document.getElementById('discord-channel-picker') && typeof loadDiscordChannelPicker === 'function') {
      loadDiscordChannelPicker();
    }
  });
});

// =============================================================================
// Push Notifications
// =============================================================================

/**
 * Convert a base64 URL-encoded string to a Uint8Array.
 * Needed for the applicationServerKey in pushManager.subscribe().
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Subscribe to push notifications.
 * Fetches the VAPID public key from the server, then subscribes via the
 * push manager and sends the subscription to the server for storage.
 */
async function subscribeToPushNotifications() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      return; // Already subscribed
    }

    // Fetch VAPID public key
    const keyResponse = await fetch('/api/push/vapid-key');
    if (!keyResponse.ok) {
      console.warn('[Push] Failed to fetch VAPID key');
      return;
    }
    const { publicKey } = await keyResponse.json();
    const applicationServerKey = urlBase64ToUint8Array(publicKey);

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });

    // Send subscription to server
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: subscription.toJSON().keys,
      }),
    });

    console.log('[Push] Subscribed to push notifications');
  } catch (err) {
    console.warn('[Push] Subscription failed:', err);
  }
}

/**
 * Request notification permission from the user.
 * If granted, automatically subscribes to push notifications.
 * Returns the permission state string.
 *
 * Exposed as window.requestNotificationPermission for use by settings UI.
 */
window.requestNotificationPermission = async function() {
  if (!('Notification' in window)) {
    return 'unsupported';
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported';
  }

  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    await subscribeToPushNotifications();
  }
  return permission;
};

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.querySelector('.sidebar-overlay');

  sidebar?.classList.toggle('open');
  overlay?.classList.toggle('open');
}

/**
 * Close sidebar after navigation (for settings links).
 */
function closeSidebarAfterNav() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.querySelector('.sidebar-overlay');

  if (sidebar?.classList.contains('open')) {
    sidebar.classList.remove('open');
    overlay?.classList.remove('open');
  }
}

// =============================================================================
// Conversations
// =============================================================================

/**
 * Load a conversation from URL on initial page load.
 * Called when user navigates directly to /c/:id
 */
async function loadConversationFromUrl(conversationId, { silent = false } = {}) {
  currentConversationId = conversationId;

  // Clear context inspector state for the new conversation
  contextSnapshots = [];
  selectedSnapshotIdx = -1;

  try {
    // Fetch the chat fragment from the dedicated fragment endpoint
    const response = await fetch(`/fragments/chat/${conversationId}`);

    if (!response.ok) {
      if (response.status === 404) {
        if (!silent) showToast('Conversation not found');
        history.replaceState({}, '', '/');
        return;
      }
      throw new Error('Failed to load conversation');
    }

    const html = await response.text();

    // Parse the response to extract OOB elements
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Handle header title OOB swap
    const headerTitleOob = doc.querySelector('#header-title[hx-swap-oob]');
    if (headerTitleOob) {
      const headerTitle = document.getElementById('header-title');
      if (headerTitle) {
        headerTitle.innerHTML = headerTitleOob.innerHTML;
      }
      headerTitleOob.remove();
    }

    // Set the chat content (without OOB elements)
    const chat = document.getElementById('chat');
    if (chat) {
      chat.innerHTML = doc.body.innerHTML;
    }

    // Re-init scroll system for new DOM — defer scroll until browser has laid out content
    AutoScroll.reinit();

    // Show/hide voice call button based on voice enabled state
    updateVoiceCallButtonVisibility();

    // Initialize lazy loading for older messages
    if (document.getElementById('load-earlier-sentinel')) {
      LazyLoader.init(conversationId);
    } else {
      LazyLoader.cleanup();
    }

    requestAnimationFrame(() => AutoScroll.jumpToBottom());

    // Mark as active in sidebar after it loads
    // Use a small delay to wait for the sidebar conversation list to load
    setTimeout(() => {
      document.querySelectorAll('.conv-item').forEach((item) => {
        item.classList.toggle('active', item.dataset.convId === conversationId);
      });
    }, 500);

    // Focus input
    focusInputWhenReady();

    // Restore any saved draft for this conversation (Discord-style persistence)
    restoreDraft();

  } catch (error) {
    console.error('Failed to load conversation:', error);
    if (!silent) showToast('Failed to load conversation');
  }
}

async function newConversation() {
  try {
    const response = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      throw new Error('Failed to create conversation');
    }

    const conversation = await response.json();
    currentConversationId = conversation.id;

    // Reconnect persistent SSE for the new conversation
    initPersistentSSE();

    // Reset header title to default
    const headerTitle = document.getElementById('header-title');
    if (headerTitle) {
      headerTitle.textContent = 'Psycheros';
    }

    // Reload conversation list
    htmx.trigger('#conv-list', 'load');

    // Clear context inspector state — new conversation has no snapshots yet
    contextSnapshots = [];
    selectedSnapshotIdx = -1;
    if (contextInspectorOpen) {
      renderContextInspector();
    }

    // Clear chat and show empty state with input area
    const chat = document.getElementById('chat');
    if (chat) {
      chat.innerHTML = `
        <div class="messages" id="messages">
          <div class="empty-state" id="empty-state">
            <div class="empty-title">Psycheros</div>
            <p class="empty-text">What's on your mind?</p>
          </div>
        </div>
        <div class="input-area">
          <div class="input-container">
            <button class="attach-btn" onclick="document.getElementById('attach-input').click()" title="Attach image">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            </button>
            <input type="file" id="attach-input" accept="image/*" style="display:none" onchange="Psycheros.handleAttachment(this)">
            <textarea
              class="input-field"
              id="message-input"
              placeholder="Type your message..."
              rows="1"
              onkeydown="Psycheros.handleKeyDown(event)"
              oninput="Psycheros.autoResize(this)"
            ></textarea>
            <button class="send-btn" id="send-btn" onclick="Psycheros.sendMessage()">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          </div>
          <div id="attachment-preview" class="attachment-preview" style="display:none;"></div>
        </div>
      `;
    }

    // Clean up lazy loader — new conversation has no older messages
    LazyLoader.cleanup();

    // Update URL
    history.pushState({}, '', `/c/${conversation.id}`);

    // Close sidebar
    const sidebar = document.getElementById('sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (sidebar?.classList.contains('open')) {
      sidebar.classList.remove('open');
      overlay?.classList.remove('open');
    }

    // Focus input
    focusInputWhenReady();

  } catch (error) {
    console.error('Failed to create conversation:', error);
    showToast('Failed to create conversation');
  }
}

function selectConversation(id) {
  // Don't abort in-progress generation — let it continue in the background
  // so the full response is persisted on the server. We just detach the
  // UI state from the old conversation's stream.
  // streamingConversationId retains the old value so sendMessage knows it's orphaned.

  // Save the draft for the conversation we're leaving BEFORE currentConversationId
  // changes. Sidebar clicks route through this function (not HTMX), so this is
  // the only save point that runs while the old conversation ID is still active.
  // (saveDraft on every keystroke keeps localStorage current, so this is mostly
  // defensive — but it's load-bearing on the first nav from the __new__ slot.)
  saveDraft();

  // Detach from the old stream without aborting it
  currentAbortController = null;
  isStreaming = false;
  pendingToolCalls.clear();
  currentConversationId = id;

  // Reconnect persistent SSE for the new conversation
  initPersistentSSE();

  // Update active state in list
  document.querySelectorAll('.conv-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.convId === id);
  });

  // Re-enable input and restore send button
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  if (input) input.disabled = false;
  if (sendBtn) {
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
    sendBtn.onclick = Psycheros.sendMessage;
    sendBtn.classList.remove('stop-btn');
    sendBtn.classList.add('send-btn');
    sendBtn.disabled = false;
  }

  // Clear context inspector state — snapshots belong to the previous conversation
  // and must not leak into the new one
  contextSnapshots = [];
  selectedSnapshotIdx = -1;
  if (contextInspectorOpen) {
    loadContextSnapshots();
  } else {
    renderContextInspector();
  }

  // Load chat content (handles both initial load and returning from settings/views)
  loadConversationFromUrl(id);

  // Update URL to reflect the selected conversation
  history.pushState({}, '', `/c/${id}`);

  // Close sidebar after selecting conversation (only if open — don't toggle)
  closeSidebarAfterNav();
}

// =============================================================================
// Input Handling
// =============================================================================

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

// =============================================================================
// Draft persistence (unsent text in the composer)
// =============================================================================

// Discord-style: unsent text lives in localStorage keyed per-conversation so
// navigating away to settings or another conversation — or closing the tab —
// doesn't lose what the user was typing. A synthetic "__new__" slot holds the
// draft for the no-conversation home view. Storage is wrapped in try/catch so
// private-mode browsers or quota errors degrade silently — no UI breakage.
//
// Saves are synchronous (no debounce): localStorage writes for short strings
// are sub-millisecond, and a debounce introduced a timing bug where the save
// fired after currentConversationId had changed on navigation, writing the
// draft to the wrong conversation's key.
const DRAFT_PREFIX = 'psycheros:draft:';
const NEW_CONVERSATION_DRAFT_KEY = DRAFT_PREFIX + '__new__';

function draftKeyForConversation(conversationId) {
  return conversationId ? (DRAFT_PREFIX + conversationId) : NEW_CONVERSATION_DRAFT_KEY;
}

function saveDraft() {
  const input = document.getElementById('message-input');
  if (!input) return;
  const key = draftKeyForConversation(currentConversationId);
  const value = input.value;
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch (_e) {
    // localStorage unavailable (private mode, quota) — drafts just won't persist
  }
}

function restoreDraft() {
  const input = document.getElementById('message-input');
  if (!input) return;
  let value = '';
  try {
    value = localStorage.getItem(draftKeyForConversation(currentConversationId)) || '';
  } catch (_e) {
    return;
  }
  input.value = value;
  if (value) autoResize(input);
}

function clearDraft(conversationId) {
  try {
    localStorage.removeItem(draftKeyForConversation(conversationId));
  } catch (_e) {
    // ignore
  }
}

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && window.innerWidth < 768);
}

function handleKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !isMobileDevice()) {
    event.preventDefault();
    sendMessage();
  }
}

// Track if stop button has been pressed once (for double-tap confirmation)
let stopConfirmed = false;
let pulseStreamingPulseId = null;

/**
 * Handle first tap on stop button - require confirmation.
 * Shows a red confirm state, then stops on second tap.
 */
function requestStopGeneration() {
  const sendBtn = document.getElementById('send-btn');
  if (!sendBtn || !isStreaming) return;

  if (stopConfirmed) {
    // Second tap - actually stop
    stopGeneration();
  } else {
    // First tap - show confirmation state (orange warning)
    stopConfirmed = true;
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    sendBtn.classList.add('stop-confirm');

    // Reset confirmation after 3 seconds if not tapped again
    setTimeout(() => {
      if (stopConfirmed && isStreaming) {
        stopConfirmed = false;
        sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
        sendBtn.classList.remove('stop-confirm');
      }
    }, 3000);
  }
}

/**
 * Stop the current generation. Posts to /api/chat/stop first so the server's
 * cancel() can mark the abort as a user-initiated Stop (not a network drop),
 * then aborts the SSE stream. The server uses the marker to break instead of
 * drain — halting further persistence and tool execution.
 */
function stopGeneration() {
  if (currentAbortController && isStreaming) {
    const convId = streamingConversationId ?? currentConversationId;
    if (convId) {
      // Fire-and-forget; the server may receive this after the abort lands,
      // in which case the flag is consumed on the next turn's start.
      fetch('/api/chat/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId }),
        keepalive: true,
      }).catch((err) => {
        console.warn('[Stop] Failed to notify server, aborting anyway:', err);
      });
    }
    currentAbortController.abort();
    currentAbortController = null;
    stopConfirmed = false;
    // The finally block in sendMessage will handle cleanup
  }
}

// =============================================================================
// Pulse Streaming Controls
// =============================================================================

/**
 * Enter Pulse streaming mode: disable input, show stop button.
 */
async function enterPulseStreamingMode() {
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');

  input?.setAttribute('disabled', '');

  if (sendBtn) {
    stopConfirmed = false;
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    sendBtn.onclick = requestStopPulseGeneration;
    sendBtn.classList.add('stop-btn');
    sendBtn.classList.remove('send-btn', 'stop-confirm');
    sendBtn.disabled = false;
  }

  // Look up the running Pulse for this conversation
  if (currentConversationId) {
    try {
      const res = await fetch(`/api/pulses/running/${currentConversationId}`);
      if (res.ok) {
        const data = await res.json();
        pulseStreamingPulseId = data.pulseId;
      }
    } catch {
      // Ignore — stop button just won't work if lookup fails
    }
  }
}

/**
 * Exit Pulse streaming mode: re-enable input, restore send button.
 */
function exitPulseStreamingMode() {
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');

  input?.removeAttribute('disabled');

  if (sendBtn) {
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
    sendBtn.onclick = Psycheros.sendMessage;
    sendBtn.classList.remove('stop-btn', 'stop-confirm');
    sendBtn.classList.add('send-btn');
    sendBtn.disabled = false;
  }

  focusInputWhenReady();
}

/**
 * Request stop for a Pulse-generated response (double-tap confirmation).
 */
function requestStopPulseGeneration() {
  const sendBtn = document.getElementById('send-btn');
  if (!sendBtn || !pulseStreamingPulseId) return;

  if (stopConfirmed) {
    stopPulseGeneration();
  } else {
    stopConfirmed = true;
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    sendBtn.classList.add('stop-confirm');
    // Reset confirmation after 3 seconds if not confirmed
    setTimeout(() => {
      if (stopConfirmed && pulseStreamingPulseId) {
        stopConfirmed = false;
        sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
        sendBtn.classList.remove('stop-confirm');
      }
    }, 3000);
  }
}

/**
 * Stop the running Pulse by calling the abort API.
 */
async function stopPulseGeneration() {
  if (!pulseStreamingPulseId) return;
  try {
    await fetch(`/api/pulses/${pulseStreamingPulseId}/stop`, { method: 'POST' });
  } catch (e) {
    console.error('Failed to stop pulse:', e);
  }
  stopConfirmed = false;
}

// =============================================================================
// Messaging
// =============================================================================

async function handleAttachment(input) {
  const file = input.files?.[0];
  if (!file) return;

  try {
    const formData = new FormData();
    formData.append('file', file);
    const resp = await fetch('/api/chat-attachments', { method: 'POST', body: formData });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showToast(err.error || 'Failed to upload attachment');
      return;
    }
    const data = await resp.json();
    pendingAttachmentId = data.id;
    pendingAttachmentUrl = data.url;

    const preview = document.getElementById('attachment-preview');
    if (preview) {
      preview.style.display = 'flex';
      preview.innerHTML = `
        <img src="${escapeHtml(data.url)}" class="attachment-thumb" alt="Attachment"/>
        <button class="attachment-remove" onclick="Psycheros.removeAttachment()">&times;</button>
      `;
    }
  } catch (error) {
    showToast('Failed to upload attachment');
  }
  input.value = '';
}

function removeAttachment() {
  pendingAttachmentId = null;
  pendingAttachmentUrl = null;
  const preview = document.getElementById('attachment-preview');
  if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
}

async function sendMessage() {
  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const message = input?.value.trim();

  if ((!message && !pendingAttachmentId) || isStreaming || pulseStreamingPulseId) return;

  // Create conversation if needed
  if (!currentConversationId) {
    try {
      const response = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const conversation = await response.json();
      currentConversationId = conversation.id;
      htmx.trigger('#conv-list', 'load');
      history.pushState({}, '', `/c/${conversation.id}`);
    } catch (_error) {
      showToast('Failed to create conversation');
      return;
    }
  }

  // Clear input and disable
  input.value = '';
  input.style.height = 'auto';
  input.disabled = true;
  clearDraft(currentConversationId);

  // Save and clear attachment before sending
  const attachmentId = pendingAttachmentId || undefined;
  const attachmentUrl = pendingAttachmentUrl || undefined;
  pendingAttachmentId = null;
  pendingAttachmentUrl = null;
  const preview = document.getElementById('attachment-preview');
  if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }

  // Switch send button to stop button (requires double-tap)
  stopConfirmed = false;
  sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  sendBtn.onclick = Psycheros.requestStopGeneration;
  sendBtn.classList.add('stop-btn');
  sendBtn.classList.remove('send-btn', 'stop-confirm');
  sendBtn.disabled = false; // Enable so user can click stop

  isStreaming = true;
  streamingConversationId = currentConversationId;

  // Remove empty state if present
  document.getElementById('empty-state')?.remove();

  // Add user message with timestamp — sending always scrolls to bottom
  const messages = document.getElementById('messages');
  const userTime = formatChatTimestamp(new Date());
  if (messages) {
    const userHtml = message ? DOMPurify.sanitize(marked.parse(message)) : '';
    const attachmentHtml = attachmentUrl
      ? `<img src="${escapeHtml(attachmentUrl)}" class="attachment-in-message" alt="Attached image" loading="lazy"/>`
      : '';
    messages.insertAdjacentHTML('beforeend', `
      <div class="msg msg--user">
        <div class="msg-header">
          <span class="msg-timestamp">${userTime}</span>
          <span>${globalThis.PsycherosSettings.userName || 'You'}</span>
        </div>
        <div class="msg-content user-text">${attachmentHtml}${userHtml}</div>
      </div>
    `);
  }
  AutoScroll.jumpToBottom();

  // Create assistant message container with current timestamp
  const assistantEl = document.createElement('div');
  assistantEl.className = 'msg msg--assistant';
  const streamTime = formatChatTimestamp(new Date());
  assistantEl.innerHTML = `
    <div class="msg-header">
      <span>${globalThis.PsycherosSettings.entityName || 'Assistant'}</span>
      <span class="msg-timestamp">${streamTime}</span>
      <div class="streaming"><span></span><span></span><span></span></div>
    </div>
    <div class="msg-content"></div>
  `;
  assistantEl.dataset.conversationId = currentConversationId;
  messages?.appendChild(assistantEl);
  AutoScroll.streamStart();

  let currentThinking = null;
  let currentContent = null;
  let currentSegmentRaw = ""; // Raw markdown buffer for current content segment

  // Create abort controller
  currentAbortController = new AbortController();

  let orphaned = false; // Set to true when user switches away from this conversation

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: currentConversationId,
        message: message || '(image attached)',
        attachmentId: attachmentId,
        deviceType: isMobileDevice() ? 'mobile' : 'desktop'
      }),
      signal: currentAbortController.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType = 'content';
    let dataLines = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Check if the user switched conversations — if so, stop rendering
      // but keep draining the reader so the server finishes and persists the response
      if (!orphaned && streamingConversationId !== currentConversationId) {
        orphaned = true;
        console.log(`Stream orphaned: switched from ${streamingConversationId} to ${currentConversationId}, draining in background`);
      }

      if (orphaned) continue; // Skip rendering, just drain the stream

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events - accumulate data lines and dispatch on blank line
      // Per SSE spec, multiple data: lines should be joined with newlines
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
          continue;
        }

        if (line.startsWith('data: ')) {
          dataLines.push(line.slice(6));
          continue;
        }

        // Empty line signals end of event - dispatch accumulated data
        if (line === '' && dataLines.length > 0) {
          const data = dataLines.join('\n');
          handleSSEEvent(currentEventType, data, assistantEl, {
            getThinking: () => currentThinking,
            setThinking: (el) => currentThinking = el,
            getContent: () => currentContent,
            setContent: (el) => currentContent = el,
            getSegmentRaw: () => currentSegmentRaw,
            setSegmentRaw: (text) => currentSegmentRaw = text,
            appendSegmentRaw: (text) => currentSegmentRaw += text,
          });
          currentEventType = 'content';
          dataLines = [];
        }
      }
    }

    // If the stream was orphaned (user switched conversations), skip all
    // UI cleanup here — selectConversation already reset the UI for the
    // new conversation. The server finished persisting the response.
    if (orphaned) {
      streamingConversationId = null;
      return;
    }
  } catch (error) {
    // If orphaned, ignore errors — the user has already moved on
    if (streamingConversationId !== currentConversationId) {
      streamingConversationId = null;
      return;
    }

    if (error.name === 'AbortError') {
      console.log('Request aborted by user');
      // Freeze whatever content was streaming with a clean render
      if (currentContent && currentSegmentRaw) {
        renderFinalContent(currentContent, currentSegmentRaw);
      }
      // Show stopped indicator
      const stoppedEl = document.createElement('div');
      stoppedEl.className = 'stopped-indicator';
      stoppedEl.textContent = '[Stopped]';
      assistantEl.querySelector('.msg-content')?.appendChild(stoppedEl);
      // Don't return — fall through to finally for full cleanup
    } else {
      console.error('Stream error:', error);
      showToast('Failed to send message: ' + error.message);

      const errorEl = document.createElement('div');
      errorEl.style.color = 'var(--c-error)';
      errorEl.textContent = 'Error: ' + error.message;
      assistantEl.querySelector('.msg-content')?.appendChild(errorEl);
    }

  } finally {
    // If the stream was orphaned (user switched conversations while this was
    // streaming), skip UI cleanup — selectConversation already handled it.
    // Just clean up the render timer and state bookkeeping.
    if (orphaned) {
      if (_renderTimer) {
        clearTimeout(_renderTimer);
        _renderTimer = null;
      }
      streamingConversationId = null;
      return;
    }

    // Kill any pending debounced render
    if (_renderTimer) {
      clearTimeout(_renderTimer);
      _renderTimer = null;
    }

    // Remove streaming indicator (header dots)
    assistantEl.querySelector('.streaming')?.remove();

    // Clean up all streaming artifacts from content area
    assistantEl.querySelectorAll('.typing-cursor').forEach(el => el.remove());
    assistantEl.querySelectorAll('.streaming-active').forEach(el => {
      el.classList.remove('streaming-active');
    });

    // Clear state
    pendingToolCalls.clear();
    currentAbortController = null;
    currentSegmentRaw = ""; // Reset markdown buffer
    streamingConversationId = null;

    // Re-enable input
    if (input) input.disabled = false;

    // Restore send button from stop button
    if (sendBtn) {
      sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
      sendBtn.onclick = Psycheros.sendMessage;
      sendBtn.classList.remove('stop-btn', 'stop-confirm');
      sendBtn.classList.add('send-btn');
      sendBtn.disabled = false;
    }

    isStreaming = false;
    focusInputWhenReady();
  }
}

// =============================================================================
// Retry Failed Turn
// =============================================================================

/**
 * Retry a failed turn. Reuses the already-persisted user message so no
 * duplicate is created in the conversation history.
 *
 * @param {HTMLElement} failedAssistantEl - The assistant message element containing the error
 */
async function retryFailedTurn(failedAssistantEl) {
  if (isStreaming) return;

  const conversationId = failedAssistantEl.dataset.conversationId;
  if (!conversationId) {
    showToast('Cannot retry: missing conversation context');
    return;
  }

  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const contentContainer = failedAssistantEl.querySelector('.msg-content');

  // Clear the error content and retry button from the failed bubble
  contentContainer.innerHTML = '';

  // Re-add streaming indicator to header
  const header = failedAssistantEl.querySelector('.msg-header');
  if (header) {
    const existingStreaming = header.querySelector('.streaming');
    if (!existingStreaming) {
      const streamingDots = document.createElement('div');
      streamingDots.className = 'streaming';
      streamingDots.innerHTML = '<span></span><span></span><span></span>';
      header.appendChild(streamingDots);
    }
  }

  // Enter streaming state
  isStreaming = true;
  streamingConversationId = conversationId;
  input && (input.disabled = true);
  stopConfirmed = false;
  sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  sendBtn.onclick = Psycheros.requestStopGeneration;
  sendBtn.classList.add('stop-btn');
  sendBtn.classList.remove('send-btn', 'stop-confirm');
  sendBtn.disabled = false;

  AutoScroll.streamStart();

  let currentThinking = null;
  let currentContent = null;
  let currentSegmentRaw = '';

  currentAbortController = new AbortController();

  try {
    const response = await fetch('/api/chat/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
      signal: currentAbortController.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType = 'content';
    let dataLines = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
          continue;
        }
        if (line.startsWith('data: ')) {
          dataLines.push(line.slice(6));
          continue;
        }
        if (line === '' && dataLines.length > 0) {
          const data = dataLines.join('\n');
          handleSSEEvent(currentEventType, data, failedAssistantEl, {
            getThinking: () => currentThinking,
            setThinking: (el) => currentThinking = el,
            getContent: () => currentContent,
            setContent: (el) => currentContent = el,
            getSegmentRaw: () => currentSegmentRaw,
            setSegmentRaw: (text) => currentSegmentRaw = text,
            appendSegmentRaw: (text) => currentSegmentRaw += text,
          });
          currentEventType = 'content';
          dataLines = [];
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      if (currentContent && currentSegmentRaw) {
        renderFinalContent(currentContent, currentSegmentRaw);
      }
      const stoppedEl = document.createElement('div');
      stoppedEl.className = 'stopped-indicator';
      stoppedEl.textContent = '[Stopped]';
      contentContainer?.appendChild(stoppedEl);
    } else {
      console.error('Retry stream error:', error);
      showToast('Retry failed: ' + error.message);
      const errorEl = document.createElement('div');
      errorEl.style.color = 'var(--c-error)';
      errorEl.textContent = 'Error: ' + error.message;
      contentContainer?.appendChild(errorEl);
    }
  } finally {
    if (_renderTimer) {
      clearTimeout(_renderTimer);
      _renderTimer = null;
    }

    failedAssistantEl.querySelector('.streaming')?.remove();
    failedAssistantEl.querySelectorAll('.typing-cursor').forEach(el => el.remove());
    failedAssistantEl.querySelectorAll('.streaming-active').forEach(el => {
      el.classList.remove('streaming-active');
    });

    pendingToolCalls.clear();
    currentAbortController = null;
    currentSegmentRaw = '';
    streamingConversationId = null;

    if (input) input.disabled = false;
    if (sendBtn) {
      sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
      sendBtn.onclick = Psycheros.sendMessage;
      sendBtn.classList.remove('stop-btn', 'stop-confirm');
      sendBtn.classList.add('send-btn');
      sendBtn.disabled = false;
    }

    isStreaming = false;
    focusInputWhenReady();
  }
}

/**
 * Start a voice call for the current conversation.
 * Checks voice status first, then delegates to voice.js openVoiceChat.
 */
async function startVoiceCall() {
  if (isStreaming) {
    showToast('Wait for the current response to finish');
    return;
  }
  try {
    const resp = await fetch('/api/voice/status');
    const status = await resp.json();
    if (!status.enabled) {
      showToast('Voice chat is not enabled');
      return;
    }
  } catch {
    showToast('Could not check voice status');
    return;
  }
  const convId = currentConversationId;
  if (!convId) {
    showToast('Select a conversation first');
    return;
  }
  openVoiceChat(convId);
}

async function testTTSConnection() {
  var btn = document.getElementById('test-tts-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Testing...';

  try {
    var resp = await fetch('/api/voice/test-tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    var contentType = resp.headers.get('Content-Type') || '';

    if (contentType.includes('audio')) {
      var blob = await resp.blob();
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      audio.play();
      var latency = resp.headers.get('X-TTS-Latency') || '?';
      var provider = resp.headers.get('X-TTS-Provider') || '?';
      btn.textContent = 'Test TTS';
      showToast('TTS test OK (' + latency + 'ms, ' + provider + ')');
      audio.onended = function() { URL.revokeObjectURL(url); };
    } else {
      var data = await resp.json();
      btn.textContent = 'Test TTS';
      showToast('TTS test failed: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (e) {
    btn.textContent = 'Test TTS';
    showToast('TTS test failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    if (btn.textContent === 'Testing...') btn.textContent = 'Test TTS';
  }
}

globalThis.testTTSConnection = testTTSConnection;

// =============================================================================
// Voice Settings
// =============================================================================

function onVoiceTTSProviderChange() {
  var provider = document.getElementById('voice-tts-provider').value;
  document.querySelectorAll('.voice-provider-fields[id^="tts-fields-"]').forEach(function(el) {
    el.style.display = 'none';
  });
  var target = document.getElementById('tts-fields-' + provider);
  if (target) target.style.display = 'block';
}

function onVoiceSTTProviderChange() {
  var provider = document.getElementById('voice-stt-provider').value;
  document.querySelectorAll('.voice-provider-fields[id^="stt-fields-"]').forEach(function(el) {
    el.style.display = 'none';
  });
  var target = document.getElementById('stt-fields-' + provider);
  if (target) target.style.display = 'block';
}

function toggleVoiceFieldVisibility(fieldId) {
  var field = document.getElementById(fieldId);
  if (!field) return;
  field.type = field.type === 'password' ? 'text' : 'password';
}

function gatherVoiceProfile() {
  var id = document.getElementById('voice-profile-id').value;
  var isNew = !id;
  var ttsProvider = document.getElementById('voice-tts-provider').value;
  var sttProvider = document.getElementById('voice-stt-provider').value;

  var profile = {
    id: isNew ? ('vp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)) : id,
    name: document.getElementById('voice-profile-name').value || 'Untitled',
    description: document.getElementById('voice-profile-desc').value || '',
    enabled: document.getElementById('voice-profile-enabled').checked,
    providerSettings: {
      tts: { provider: ttsProvider },
      stt: { provider: sttProvider }
    },
    pronunciation: [],
    sttCorrections: [],
    customInstructions: document.getElementById('voice-custom-instructions').value || '',
    audioEffects: [],
    contextWindowSize: parseInt(document.getElementById('voice-context-window').value) || 64000,
    vadThreshold: parseFloat(document.getElementById('voice-vad-threshold').value) || 0.5,
    idleTimeoutSeconds: parseInt(document.getElementById('voice-idle-timeout').value) || 300,
    ttsKeepAliveDays: parseInt(document.getElementById('voice-keep-alive-days').value) || 0,
    pushToTalk: document.getElementById('voice-push-to-talk')?.checked ?? false,
    disableReasoning: document.getElementById('voice-disable-reasoning')?.checked ?? true,
    endOfTurnSilence: parseFloat(document.getElementById('voice-end-of-turn-silence')?.value ?? 1.5),
    phraseDebounceMs: parseInt(document.getElementById('voice-phrase-debounce')?.value ?? 1200),
    sttDebug: document.getElementById('voice-stt-debug')?.checked ?? false,
    voiceEffect: document.getElementById('voice-effect')?.value ?? 'none',
  };

  // TTS provider fields
  if (ttsProvider === 'minimax') {
    profile.providerSettings.tts.minimax = {
      apiKey: document.getElementById('tts-minimax-api-key').value,
      groupId: document.getElementById('tts-minimax-group-id').value,
      voiceId: document.getElementById('tts-minimax-voice-id').value,
      model: document.getElementById('tts-minimax-model').value || 'speech-2.8-hd',
    };
  } else if (ttsProvider === 'elevenlabs') {
    profile.providerSettings.tts.elevenlabs = {
      apiKey: document.getElementById('tts-elevenlabs-api-key').value,
      voiceId: document.getElementById('tts-elevenlabs-voice-id').value,
      model: document.getElementById('tts-elevenlabs-model').value || 'eleven_multilingual_v2',
    };
  } else if (ttsProvider === 'openai') {
    profile.providerSettings.tts.openai = {
      apiKey: document.getElementById('tts-openai-api-key').value,
      baseUrl: document.getElementById('tts-openai-base-url').value,
      voice: document.getElementById('tts-openai-voice').value,
      model: document.getElementById('tts-openai-model').value || 'tts-1',
    };
  } else if (ttsProvider === 'custom') {
    profile.providerSettings.tts.custom = {
      baseUrl: document.getElementById('tts-custom-base-url').value,
      apiKey: document.getElementById('tts-custom-api-key').value || undefined,
      model: document.getElementById('tts-custom-model').value,
      voice: document.getElementById('tts-custom-voice').value,
    };
  }

  // STT provider fields
  if (sttProvider === 'browser') {
    profile.providerSettings.stt.browser = {
      language: document.getElementById('stt-browser-language').value || undefined,
    };
  } else if (sttProvider === 'deepgram') {
    profile.providerSettings.stt.deepgram = {
      apiKey: document.getElementById('stt-deepgram-api-key').value,
      model: document.getElementById('stt-deepgram-model').value || 'nova-2',
      language: document.getElementById('stt-deepgram-language').value || 'en',
    };
  } else if (sttProvider === 'openai') {
    profile.providerSettings.stt.openai = {
      apiKey: document.getElementById('stt-openai-api-key').value,
      baseUrl: document.getElementById('stt-openai-base-url').value,
      model: document.getElementById('stt-openai-model').value || 'whisper-1',
    };
  } else if (sttProvider === 'custom') {
    profile.providerSettings.stt.custom = {
      baseUrl: document.getElementById('stt-custom-base-url').value,
      apiKey: document.getElementById('stt-custom-api-key').value || undefined,
      model: document.getElementById('stt-custom-model').value,
      language: document.getElementById('stt-custom-language').value || undefined,
    };
  }

  // Pronunciation entries (text → phonetic for TTS)
  var pronRows = document.querySelectorAll('#pronunciation-list .pronunciation-row');
  pronRows.forEach(function(row) {
    var inputs = row.querySelectorAll('input[type="text"]');
    if (inputs.length >= 2 && inputs[0].value && inputs[1].value) {
      profile.pronunciation.push({ written: inputs[0].value, spoken: inputs[1].value });
    }
  });

  // STT correction entries (misheard → correct, applied before LLM)
  var corrRows = document.querySelectorAll('#stt-corrections-list .stt-correction-row');
  corrRows.forEach(function(row) {
    var inputs = row.querySelectorAll('input[type="text"]');
    if (inputs.length >= 2 && inputs[0].value && inputs[1].value) {
      profile.sttCorrections.push({ misheard: inputs[0].value, correct: inputs[1].value });
    }
  });

  return profile;
}

async function saveVoiceProfile(event) {
  if (event) event.preventDefault();
  var profile = gatherVoiceProfile();

  try {
    // Fetch current settings to merge the profile into
    var resp = await fetch('/api/voice/settings');
    var settings = await resp.json();

    // Find and replace or push
    var idx = settings.profiles.findIndex(function(p) { return p.id === profile.id; });
    if (idx >= 0) {
      // Preserve lastKeepAlive from existing profile
      if (settings.profiles[idx].lastKeepAlive) {
        profile.lastKeepAlive = settings.profiles[idx].lastKeepAlive;
      }
      settings.profiles[idx] = profile;
    } else {
      settings.profiles.push(profile);
      // Auto-set as active if first profile
      if (!settings.activeProfileId) {
        settings.activeProfileId = profile.id;
      }
    }

    var saveResp = await fetch('/api/voice/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    var result = await saveResp.json();
    if (result.success) {
      showToast('Voice profile saved');
      htmx.ajax('GET', '/fragments/settings/voice', { target: '#chat', swap: 'innerHTML' });
    } else {
      showToast('Failed to save: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (e) {
    showToast('Failed to save: ' + e.message, 'error');
  }
}

async function deleteVoiceProfile(profileId) {
  var btn = document.getElementById('delete-voice-profile-btn');
  if (!btn) return;
  if (!btn.dataset.confirming) {
    btn.dataset.confirming = 'true';
    btn.textContent = 'Confirm Delete?';
    btn.classList.add('btn--danger');
    btn.classList.remove('btn--ghost');
    setTimeout(function() {
      if (btn.dataset.confirming) {
        delete btn.dataset.confirming;
        btn.textContent = 'Delete Profile';
        btn.classList.remove('btn--danger');
        btn.classList.add('btn--ghost');
      }
    }, 3000);
    return;
  }

  try {
    var resp = await fetch('/api/voice/settings');
    var settings = await resp.json();
    settings.profiles = settings.profiles.filter(function(p) { return p.id !== profileId; });
    if (settings.activeProfileId === profileId) {
      settings.activeProfileId = settings.profiles.length > 0 ? settings.profiles[0].id : null;
    }
    var saveResp = await fetch('/api/voice/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    var result = await saveResp.json();
    if (result.success) {
      showToast('Voice profile deleted');
      htmx.ajax('GET', '/fragments/settings/voice', { target: '#chat', swap: 'innerHTML' });
    } else {
      showToast('Failed to delete: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (e) {
    showToast('Failed to delete: ' + e.message, 'error');
  }
}

async function setActiveVoiceProfile(profileId) {
  try {
    var resp = await fetch('/api/voice/settings');
    var settings = await resp.json();
    settings.activeProfileId = profileId;
    var saveResp = await fetch('/api/voice/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    var result = await saveResp.json();
    if (result.success) {
      showToast('Active voice profile updated');
      htmx.ajax('GET', '/fragments/settings/voice', { target: '#chat', swap: 'innerHTML' });
    } else {
      showToast('Failed to set active: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (e) {
    showToast('Failed to set active: ' + e.message, 'error');
  }
}

async function toggleVoiceEnabled() {
  var enabled = document.getElementById('voice-enabled').checked;
  try {
    var resp = await fetch('/api/voice/settings');
    var settings = await resp.json();
    settings.enabled = enabled;
    var saveResp = await fetch('/api/voice/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    var result = await saveResp.json();
    if (result.success) {
      showToast(enabled ? 'Voice chat enabled (restart may be needed)' : 'Voice chat disabled');
    } else {
      showToast('Failed: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (e) {
    showToast('Failed: ' + e.message, 'error');
  }
}

// =============================================================================
// Push-to-Talk global settings
// =============================================================================

var pttKeyCaptureActive = false;
var pttCaptureSilentAudio = null;

function capturePTTKey() {
  pttKeyCaptureActive = true;
  var hint = document.getElementById('ptt-capture-hint');
  var addBtn = document.getElementById('ptt-add-key-btn');
  if (hint) hint.style.display = 'block';
  if (addBtn) addBtn.style.display = 'none';
  document.addEventListener('keydown', handlePTTKeyCapture, true);
  document.addEventListener('mousedown', handlePTTMouseCapture, true);
  // Play silent audio so the OS routes Bluetooth media button events to
  // the page. Without active audio, Android doesn't give us the media
  // session and Shokz/headset buttons never fire. The user clicked "Add
  // binding" to get here, which counts as the user gesture play() needs.
  // Mobile-only — desktop Chrome gets media key events on focused tabs
  // without claiming the session, and the empty WAV data URL we used
  // previously spun Chrome's audio thread on loop.
  var isMobile = typeof navigator !== 'undefined' &&
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  if (isMobile && !pttCaptureSilentAudio) {
    // Generate a real 1-second silent WAV — empty WAVs loop infinitely
    // fast and freeze Chrome. Same approach as voice.js's startSilentAudio.
    try {
      var sampleRate = 8000;
      var numSamples = sampleRate * 1;
      var buf = new ArrayBuffer(44 + numSamples);
      var view = new DataView(buf);
      var writeAscii = function (offset, str) {
        for (var i = 0; i < str.length; i++) {
          view.setUint8(offset + i, str.charCodeAt(i));
        }
      };
      writeAscii(0, 'RIFF');
      view.setUint32(4, 36 + numSamples, true);
      writeAscii(8, 'WAVE');
      writeAscii(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate, true);
      view.setUint16(32, 1, true);
      view.setUint16(34, 8, true);
      writeAscii(36, 'data');
      view.setUint32(40, numSamples, true);
      for (var i = 0; i < numSamples; i++) {
        view.setUint8(44 + i, 0x80);
      }
      var blob = new Blob([buf], { type: 'audio/wav' });
      var url = URL.createObjectURL(blob);
      pttCaptureSilentAudio = new Audio(url);
      pttCaptureSilentAudio.loop = true;
      pttCaptureSilentAudio.volume = 0.001;
    } catch (e) {
      console.debug('[PTT capture] Silent audio setup failed:', e);
    }
  }
  if (pttCaptureSilentAudio) {
    pttCaptureSilentAudio.play().catch(function (err) {
      console.debug('[PTT capture] Silent audio play() failed:', err);
    });
  }
  // Also capture MediaSession actions for Bluetooth headset buttons.
  // Activate a temporary session so the OS routes media key events to us.
  if ('mediaSession' in navigator) {
    if (!navigator.mediaSession.metadata) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'PTT Capture' });
    }
    var actions = ['play', 'pause', 'previoustrack', 'nexttrack', 'stop'];
    actions.forEach(function (action) {
      try {
        navigator.mediaSession.setActionHandler(action, function () {
          if (!pttKeyCaptureActive) return;
          addPTTKeyBinding('MediaSession:' + action);
          cancelPTTKeyCapture();
        });
      } catch (e) { /* not all actions are supported on all browsers */ }
    });
  }
}

function cancelPTTKeyCapture() {
  pttKeyCaptureActive = false;
  var hint = document.getElementById('ptt-capture-hint');
  var addBtn = document.getElementById('ptt-add-key-btn');
  if (hint) hint.style.display = 'none';
  if (addBtn) addBtn.style.display = '';
  document.removeEventListener('keydown', handlePTTKeyCapture, true);
  document.removeEventListener('mousedown', handlePTTMouseCapture, true);
  // Stop the silent audio used to claim the media session during capture.
  if (pttCaptureSilentAudio) {
    try { pttCaptureSilentAudio.pause(); } catch (e) {}
  }
  // Clean up MediaSession action handlers set during capture
  if ('mediaSession' in navigator) {
    var actions = ['play', 'pause', 'previoustrack', 'nexttrack', 'stop'];
    actions.forEach(function (action) {
      try { navigator.mediaSession.setActionHandler(action, null); } catch (e) {}
    });
  }
}

function handlePTTKeyCapture(e) {
  if (!pttKeyCaptureActive) return;
  e.preventDefault();
  e.stopPropagation();
  var key = e.code;
  addPTTKeyBinding(key);
  cancelPTTKeyCapture();
}

function handlePTTMouseCapture(e) {
  if (!pttKeyCaptureActive) return;
  // Ignore clicks on the Cancel button
  if (e.target.closest && e.target.closest('#ptt-capture-hint')) return;
  e.preventDefault();
  e.stopPropagation();
  var key = 'Mouse' + e.button;
  addPTTKeyBinding(key);
  cancelPTTKeyCapture();
}

async function addPTTKeyBinding(key) {
  try {
    var resp = await fetch('/api/voice/settings');
    var settings = await resp.json();
    if (!settings.pttKeys) settings.pttKeys = ['Space'];
    if (settings.pttKeys.includes(key)) {
      showToast('That key is already bound');
      return;
    }
    settings.pttKeys.push(key);
    await fetch('/api/voice/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    // Reload the settings view to show the new chip
    htmx.ajax('GET', '/fragments/settings/voice', { target: '#chat', swap: 'innerHTML' });
  } catch (e) {
    console.warn('Failed to add PTT key binding:', e);
  }
}

async function removePTTKeyBinding(index) {
  try {
    var resp = await fetch('/api/voice/settings');
    var settings = await resp.json();
    if (!settings.pttKeys) return;
    settings.pttKeys.splice(index, 1);
    // Don't allow removing the last binding
    if (settings.pttKeys.length === 0) {
      showToast('At least one key binding is required');
      settings.pttKeys = ['Space'];
    }
    await fetch('/api/voice/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    htmx.ajax('GET', '/fragments/settings/voice', { target: '#chat', swap: 'innerHTML' });
  } catch (e) {
    console.warn('Failed to remove PTT key binding:', e);
  }
}

function addPronunciationEntry() {
  var list = document.getElementById('pronunciation-list');
  if (!list) return;
  var idx = list.querySelectorAll('.pronunciation-row').length;
  var row = document.createElement('div');
  row.className = 'pronunciation-row';
  row.dataset.idx = idx;
  row.innerHTML =
    '<input type="text" class="input-field llm-input" placeholder="Written (e.g. Psycheros)">' +
    '<span style="color: var(--text-dim);">&rarr;</span>' +
    '<input type="text" class="input-field llm-input" placeholder="Spoken (e.g. sy-KEH-ros)">' +
    '<button class="btn btn--ghost btn--sm" onclick="removePronunciationEntry(this)" title="Remove">&times;</button>';
  list.appendChild(row);
}

function removePronunciationEntry(el) {
  var row = el.closest ? el.closest('.pronunciation-row') : el.parentElement;
  if (row) row.remove();
}

function addSTTCorrectionEntry() {
  var list = document.getElementById('stt-corrections-list');
  if (!list) return;
  var row = document.createElement('div');
  row.className = 'pronunciation-row stt-correction-row';
  row.innerHTML =
    '<input type="text" class="input-field llm-input" placeholder="Misheard (e.g. sih keh ros)">' +
    '<span style="color: var(--text-dim);">&rarr;</span>' +
    '<input type="text" class="input-field llm-input" placeholder="Correct (e.g. Psycheros)">' +
    '<button class="btn btn--ghost btn--sm" onclick="removeSTTCorrectionEntry(this)" title="Remove">&times;</button>';
  list.appendChild(row);
}

function removeSTTCorrectionEntry(el) {
  var row = el.closest ? el.closest('.stt-correction-row') : el.parentElement;
  if (row) row.remove();
}

globalThis.onVoiceTTSProviderChange = onVoiceTTSProviderChange;
globalThis.onVoiceSTTProviderChange = onVoiceSTTProviderChange;
globalThis.toggleVoiceFieldVisibility = toggleVoiceFieldVisibility;
globalThis.saveVoiceProfile = saveVoiceProfile;
globalThis.deleteVoiceProfile = deleteVoiceProfile;
globalThis.setActiveVoiceProfile = setActiveVoiceProfile;
globalThis.toggleVoiceEnabled = toggleVoiceEnabled;
globalThis.capturePTTKey = capturePTTKey;
globalThis.cancelPTTKeyCapture = cancelPTTKeyCapture;
globalThis.removePTTKeyBinding = removePTTKeyBinding;
globalThis.addPronunciationEntry = addPronunciationEntry;
globalThis.removePronunciationEntry = removePronunciationEntry;
globalThis.addSTTCorrectionEntry = addSTTCorrectionEntry;
globalThis.removeSTTCorrectionEntry = removeSTTCorrectionEntry;

// =============================================================================
// Streaming Content Renderer
// =============================================================================

/**
 * Attach data-message-id and edit button to a streaming-created message element.
 * This mirrors what the server templates do for server-rendered messages.
 */
function addMessageEditCapability(element, messageId) {
  if (!element || !messageId) return;
  element.setAttribute('data-message-id', messageId);
  // Don't add duplicate edit buttons
  if (element.querySelector('.msg-edit-btn')) return;
  const header = element.querySelector('.msg-header');
  if (!header) return;
  const btn = document.createElement('button');
  btn.className = 'msg-edit-btn';
  btn.title = 'Edit message';
  btn.onclick = () => Psycheros.startMessageEdit(messageId);
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  header.appendChild(btn);
}

/**
 * Strip XML tags emitted by the LLM that shouldn't be displayed.
 * Removes <t>timestamp</t> tags entirely (tag + content), and cleans
 * up any resulting whitespace debris.
 */
function stripEntityXml(text) {
  // Remove <t>...</t> timestamp tags and their content
  let result = text.replace(/<t>[^<]*<\/t>\s*/g, '');
  // Remove trailing partial <t> tag (chunk boundary artifact)
  result = result.replace(/<t>[^<]*$/, '');
  // Remove other non-HTML XML wrapper tags (keep inner content)
  // Matches tags like <base_instructions>, <context>, etc. but NOT standard HTML
  const htmlTags = new Set([
    'a','b','i','u','p','br','hr','em','ol','ul','li','td','th','tr',
    'h1','h2','h3','h4','h5','h6','pre','code','del','sub','sup','img',
    'div','span','strong','table','thead','tbody','tfoot','blockquote',
    'caption','details','summary','section','article','header','footer',
  ]);
  result = result.replace(/<\/?([a-z_][a-z0-9_-]*)\b[^>]*>/gi, (match, tag) => {
    return htmlTags.has(tag.toLowerCase()) ? match : '';
  });
  // Collapse excessive whitespace left by removals
  result = result.replace(/[ \t]{3,}/g, ' ');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

// Configure marked to match server-side settings — preserves line breaks in
// blockquotes and other multi-line content (e.g. group chat transcripts).
marked.setOptions({ breaks: true, gfm: true });

// Force all markdown links to open in a new tab so the user doesn't
// lose their Psycheros session when clicking a link the entity shared.
const _origLink = marked.Renderer.prototype.link;
marked.Renderer.prototype.link = function(href, title, text) {
  return _origLink.call(this, href, title, text).replace('<a ', '<a target="_blank" rel="noopener" ');
};

/** Debounce timer for progressive markdown rendering */
let _renderTimer = null;

/**
 * Render cleaned markdown into a content element (live, during streaming).
 * Appends a typing cursor to the last block element.
 */
function renderStreamingContent(contentEl, rawContent) {
  const cleaned = stripEntityXml(rawContent);
  if (!cleaned.trim()) return;
  try {
    const html = marked.parse(cleaned);
    contentEl.innerHTML = DOMPurify.sanitize(html);
    // Append typing cursor to the last block element
    const lastBlock = contentEl.lastElementChild || contentEl;
    if (!lastBlock.querySelector('.typing-cursor')) {
      const cursor = document.createElement('span');
      cursor.className = 'typing-cursor';
      cursor.textContent = '\u258C'; // ▌ block cursor character
      lastBlock.appendChild(cursor);
    }
  } catch (e) {
    console.error('Streaming markdown parse error:', e);
    contentEl.textContent = cleaned;
  }
}

/**
 * Schedule a debounced streaming render. Renders immediately on first call,
 * then debounces subsequent calls to avoid layout thrashing.
 */
function scheduleStreamingRender(contentEl, rawContent) {
  if (_renderTimer) clearTimeout(_renderTimer);
  _renderTimer = setTimeout(() => {
    renderStreamingContent(contentEl, rawContent);
    _renderTimer = null;
  }, 40);
}

/**
 * Final render: clean markdown with no cursor, used when freezing a
 * content segment (on tool_call) or completing the stream (on done).
 */
function renderFinalContent(contentEl, rawContent) {
  if (_renderTimer) {
    clearTimeout(_renderTimer);
    _renderTimer = null;
  }
  const cleaned = stripEntityXml(rawContent);
  if (!cleaned.trim()) {
    contentEl.remove();
    return;
  }
  try {
    const html = marked.parse(cleaned);
    contentEl.innerHTML = DOMPurify.sanitize(html);
  } catch (e) {
    console.error('Final markdown parse error:', e);
    contentEl.textContent = cleaned;
  }
  contentEl.dataset.rawContent = cleaned;
  contentEl.classList.remove('streaming-active');
}

// =============================================================================
// SSE Event Handling
// =============================================================================

function handleSSEEvent(eventType, data, messageEl, state) {
  const contentContainer = messageEl.querySelector('.msg-content');

  switch (eventType) {
    case 'thinking': {
      // Clear retry indicator — upstream recovered
      const retryThink = contentContainer.querySelector('.status-retry');
      if (retryThink) retryThink.remove();
      if (!state.getThinking()) {
        const thinkingSection = document.createElement('div');
        thinkingSection.className = 'thinking expanded';
        thinkingSection.innerHTML = `
          <div class="thinking-header" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="thinking-toggle">&#9660;</span>
            <span>Thinking</span>
          </div>
          <div class="thinking-content"></div>
        `;
        contentContainer.insertBefore(thinkingSection, contentContainer.firstChild);
        state.setThinking(thinkingSection.querySelector('.thinking-content'));
      }
      state.getThinking().textContent += data;
      AutoScroll.streamTick();
      break;
    }

    case 'thinking_corrected': {
      // Provider misroute recovery — server detected that the entire response
      // was streamed through the reasoning field. Clear the thinking section,
      // optionally re-create it with just the residual thinking, and render
      // the recovered reply as assistant-text so it's visible/editable.
      try {
        const correction = JSON.parse(data);

        const existingThinking = contentContainer.querySelector('.thinking');
        if (existingThinking) existingThinking.remove();
        state.setThinking(null);

        // Also clear any half-built assistant-text from earlier content chunks
        // (shouldn't normally happen in the misroute case, but be safe).
        if (state.getContent()) {
          state.getContent().remove();
          state.setContent(null);
          state.setSegmentRaw('');
        }

        if (correction.thinking) {
          const residual = document.createElement('div');
          residual.className = 'thinking';
          residual.innerHTML = `
            <div class="thinking-header" onclick="this.parentElement.classList.toggle('expanded')">
              <span class="thinking-toggle">&#9660;</span>
              <span>Thinking</span>
            </div>
            <div class="thinking-content"></div>
          `;
          residual.querySelector('.thinking-content').textContent = correction.thinking;
          contentContainer.insertBefore(residual, contentContainer.firstChild);
          // Don't set state.thinking — next iteration's thinking chunks should
          // create a fresh section rather than append to the residual.
        }

        if (correction.content) {
          const contentEl = document.createElement('div');
          contentEl.className = 'assistant-text';
          contentContainer.appendChild(contentEl);
          state.setContent(contentEl);
          state.setSegmentRaw(correction.content);
          renderFinalContent(contentEl, correction.content);
        }

        AutoScroll.streamTick();
      } catch (e) {
        console.error('Failed to handle thinking_corrected:', e);
      }
      break;
    }

    case 'content': {
      // Clear retry indicator — upstream recovered
      const retryContent = contentContainer.querySelector('.status-retry');
      if (retryContent) retryContent.remove();
      if (!state.getContent()) {
        const contentEl = document.createElement('div');
        contentEl.className = 'assistant-text streaming-active';
        contentContainer.appendChild(contentEl);
        state.setContent(contentEl);
        state.setSegmentRaw('');
      }
      // Accumulate raw content for this segment and schedule progressive render
      state.appendSegmentRaw(data);
      scheduleStreamingRender(state.getContent(), state.getSegmentRaw());
      AutoScroll.streamTick();
      break;
    }

    case 'tool_call':
      try {
        // Freeze the current content segment with a final render before tool card
        if (state.getContent() && state.getSegmentRaw()) {
          renderFinalContent(state.getContent(), state.getSegmentRaw());
        }
        state.setContent(null);
        state.setSegmentRaw('');

        const toolCall = JSON.parse(data);
        const toolCard = createToolCard(toolCall);
        toolCard.dataset.toolCallId = toolCall.id;
        pendingToolCalls.set(toolCall.id, toolCard);
        contentContainer.appendChild(toolCard);
        AutoScroll.streamTick();
      } catch (e) {
        console.error('Failed to parse tool call:', e);
      }
      break;

    case 'tool_result':
      try {
        const result = JSON.parse(data);
        const toolCard = pendingToolCalls.get(result.toolCallId);
        if (toolCard) {
          addToolResult(toolCard, result);
          // Re-expand the card so the result is visible (the done event
          // collapsed it while tools were still executing). The image (if
          // any) renders as a sibling via the separate image_generated
          // event, so we don't need to keep this card pinned open.
          toolCard.classList.add('expanded');
          pendingToolCalls.delete(result.toolCallId);
          AutoScroll.streamTick();
        }
      } catch (e) {
        console.error('Failed to parse tool result:', e);
      }
      break;

    case 'image_generated':
      try {
        const img = JSON.parse(data);
        const container = document.createElement('div');
        container.className = 'generated-image-container';
        // Optional Show-caption toggle. The description arrives in the SSE
        // payload; the toggle uses toolCallId as a stable anchor so it
        // survives HTMX swaps of the surrounding content.
        const captionHtml = img.description && img.toolCallId
          ? `<div class="generated-image-caption-toggle" onclick="Psycheros.toggleImageCaption('${escapeHtml(img.toolCallId)}')">▸ Show caption</div>
             <div class="generated-image-caption" id="caption-${escapeHtml(img.toolCallId)}" hidden>${escapeHtml(img.description)}</div>`
          : '';
        container.innerHTML = `
          <img src="${escapeHtml(img.imagePath)}" alt="${escapeHtml(img.prompt)}"
               class="generated-image" loading="lazy"/>
          <div class="generated-image-meta">${escapeHtml(img.generatorName)}</div>
          ${captionHtml}
        `;
        contentContainer.appendChild(container);
        AutoScroll.streamTick();
      } catch (e) {
        console.error('Failed to parse image_generated event:', e);
      }
      break;

    case 'dom_update':
      try {
        const update = JSON.parse(data);
        const target = document.querySelector(update.target);
        if (target) {
          htmx.swap(target, update.html, { swapStyle: update.swap || 'innerHTML' });
        }
      } catch (e) {
        console.error('Failed to handle dom_update:', e);
      }
      break;

    case 'status': {
      try {
        const status = JSON.parse(data);
        if (status.retry) {
          // Transient retry indicator — remove any previous one first
          const prev = contentContainer.querySelector('.status-retry');
          if (prev) prev.remove();
          const retryEl = document.createElement('div');
          retryEl.className = 'status status-retry';
          retryEl.textContent = status.message;
          contentContainer.appendChild(retryEl);
          showToast(status.message, 'warning');
          AutoScroll.streamTick();
        } else if (status.error) {
          // Remove retry indicator if present — we've moved past it
          const retryEl = contentContainer.querySelector('.status-retry');
          if (retryEl) retryEl.remove();
          const errorEl = document.createElement('div');
          errorEl.className = 'status error';
          errorEl.style.color = 'var(--c-error)';
          errorEl.textContent = status.error;
          contentContainer.appendChild(errorEl);

          // Show retry button if no assistant text content was produced this turn.
          // Tool cards are intermediate steps in the agentic loop, not a final
          // response — the entity may have made a tool call but gotten rate-limited
          // before generating the actual reply.
          const hasAssistantContent = contentContainer.querySelector('.assistant-text')
            || contentContainer.querySelector('.thinking');
          if (!hasAssistantContent && messageEl.dataset.conversationId) {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'retry-btn';
            retryBtn.textContent = 'Retry';
            retryBtn.type = 'button';
            retryBtn.onclick = () => retryFailedTurn(messageEl);
            contentContainer.appendChild(retryBtn);
          }

          showToast(status.error);
        }
      } catch {
        // Fallback for non-JSON status messages
        const statusEl = document.createElement('div');
        statusEl.className = 'status';
        statusEl.textContent = data;
        contentContainer.appendChild(statusEl);
      }
      break;
    }

    case 'metrics':
      try {
        const metrics = JSON.parse(data);
        const indicator = createMetricsIndicator(metrics);
        const header = messageEl.querySelector('.msg-header');
        if (header) {
          // Replace existing indicator to avoid duplicates from multi-iteration turns
          const existing = header.querySelector('.metrics-indicator');
          if (existing) {
            existing.remove();
          }
          header.appendChild(indicator);
        }
      } catch (e) {
        console.error('Failed to parse metrics:', e);
      }
      break;

    case 'context':
      // SSE context event is a notification — reload from REST if inspector is open
      if (contextInspectorOpen) {
        loadContextSnapshots();
      }
      break;

    case 'done': {
      // Collapse all thinking and tool sections after streaming completes.
      contentContainer.querySelectorAll('.thinking.expanded, .tool.expanded').forEach(el => {
        el.classList.remove('expanded');
      });

      // Final render of the last content segment
      const doneContentEl = state.getContent();
      const doneSegmentRaw = state.getSegmentRaw();
      if (doneContentEl && doneSegmentRaw) {
        renderFinalContent(doneContentEl, doneSegmentRaw);
      }

      // Remove any lingering cursors and streaming-active markers
      contentContainer.querySelectorAll('.typing-cursor').forEach(el => el.remove());
      contentContainer.querySelectorAll('.streaming-active').forEach(el => {
        el.classList.remove('streaming-active');
      });

      // When finish_reason is tool_calls, the agentic loop continues —
      // keep the streaming indicator and auto-scroll alive so the user
      // sees tool results and the next LLM iteration.
      if (data !== 'tool_calls') {
        const header = messageEl.querySelector('.msg-header');
        header?.querySelector('.streaming')?.remove();
        AutoScroll.streamEnd();
      }
      break;
    }

    case 'message_id': {
      try {
        const { role, id } = JSON.parse(data);
        if (role === 'user') {
          // Find the last user message without a data-message-id
          const messages = document.getElementById('messages');
          if (messages) {
            const userMsgs = messages.querySelectorAll('.msg--user:not([data-message-id])');
            const lastUserMsg = userMsgs[userMsgs.length - 1];
            if (lastUserMsg) addMessageEditCapability(lastUserMsg, id);
          }
        } else if (role === 'assistant') {
          addMessageEditCapability(messageEl, id);
        }
      } catch (e) {
        console.error('Failed to handle message_id:', e);
      }
      break;
    }
  }
}

// =============================================================================
// DOM Helpers
// =============================================================================

function createToolCard(toolCall) {
  const card = document.createElement('div');
  card.className = 'tool expanded';

  const name = toolCall.function?.name || toolCall.name || 'unknown';
  const rawArgs = toolCall.function?.arguments || toolCall.arguments || '{}';
  let args = rawArgs;

  // Generate brief summary for collapsed state
  let summary = '';
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed.command) {
      const cmd = parsed.command;
      summary = cmd.length > 50 ? cmd.substring(0, 50) + '...' : cmd;
    }
  } catch {
    // Keep summary empty
  }

  // Format JSON for expanded view
  try {
    if (typeof args === 'string') {
      args = JSON.stringify(JSON.parse(args), null, 2);
    } else {
      args = JSON.stringify(args, null, 2);
    }
  } catch {
    // Keep as-is
  }

  card.innerHTML = `
    <div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
      <span class="tool-icon">&#9881;</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      ${summary ? `<span class="tool-summary">${escapeHtml(summary)}</span>` : ''}
      <span class="tool-toggle">&#9660;</span>
    </div>
    <div class="tool-args">${escapeHtml(args)}</div>
  `;

  return card;
}

function addToolResult(card, result) {
  const resultEl = document.createElement('div');
  const isError = result.isError ?? false;
  const content = result.content;
  resultEl.className = 'tool-result' + (isError ? ' error' : '');

  let displayContent = content;
  try {
    if (typeof content === 'string' && (content.startsWith('{') || content.startsWith('['))) {
      displayContent = JSON.stringify(JSON.parse(content), null, 2);
    }
  } catch {
    // Keep as-is
  }

  resultEl.innerHTML = `
    <div class="tool-result-label">${isError ? 'Error' : 'Output'}</div>
    ${escapeHtml(displayContent)}
  `;

  card.appendChild(resultEl);
}

/**
 * Toggle the long-caption disclosure on an image-bearing tool card.
 * Lookup by toolCallId so the onclick attribute survives HTMX swaps —
 * the card itself may be re-rendered, but the id is stable per generation.
 */
function toggleImageCaption(toolCallId) {
  const caption = document.getElementById(`caption-${toolCallId}`);
  if (!caption) return;
  const toggle = caption.previousElementSibling;
  const isHidden = caption.hasAttribute('hidden');
  if (isHidden) {
    caption.removeAttribute('hidden');
    if (toggle) toggle.textContent = '▾ Hide caption';
  } else {
    caption.setAttribute('hidden', '');
    if (toggle) toggle.textContent = '▸ Show caption';
  }
}

// =============================================================================
// Smart Auto-Scroll
// Proximity-based latching: auto-scrolls only when user is near the bottom.
// Disengages when user scrolls up; shows a "scroll to bottom" pill.
// =============================================================================

const AutoScroll = (() => {
  const NEAR_BOTTOM_THRESHOLD = 80; // px from bottom to consider "latched"
  let _latched = true;
  let _pill = null;
  let _badge = null;
  let _messagesEl = null;
  let _streaming = false;
  let _hasNewContent = false;

  /**
   * Ensure AutoScroll is connected to live DOM elements.
   * Handles stale references from innerHTML replacements (loadConversationFromUrl, etc).
   */
  function ensureReady() {
    if (_messagesEl && _messagesEl.isConnected && _pill && _pill.isConnected) return true;
    // DOM was replaced or never initialized — (re)init
    cleanup();
    return setup();
  }

  function cleanup() {
    if (_pill && _pill.isConnected) _pill.remove();
    if (_messagesEl) _messagesEl.removeEventListener('scroll', onScroll);
    _pill = null;
    _badge = null;
    _messagesEl = null;
  }

  function setup() {
    _messagesEl = document.getElementById('messages');
    if (!_messagesEl) return false;

    // Create scroll-to-bottom pill with new-content badge
    _pill = document.createElement('button');
    _pill.className = 'scroll-to-bottom-pill';
    _pill.setAttribute('aria-label', 'Scroll to bottom');
    _pill.innerHTML = `
      <span class="scroll-pill-badge" aria-hidden="true"></span>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 3v8.5M4 8l4 4.5L12 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    _badge = _pill.querySelector('.scroll-pill-badge');
    _pill.addEventListener('click', () => {
      // Instant scroll during streaming — smooth scroll races with growing content
      doScrollToBottom(!_streaming);
      _latched = true;
      _hasNewContent = false;
      hidePill();
    });

    // Insert pill inside .chat — positioned absolutely above the input area
    const chat = _messagesEl.closest('.chat') || _messagesEl.parentElement;
    if (chat) {
      chat.style.position = 'relative';
      chat.appendChild(_pill);
    }

    // Listen for user scroll
    _messagesEl.addEventListener('scroll', onScroll, { passive: true });
    return true;
  }

  function onScroll() {
    if (!_messagesEl) return;
    _latched = isNearBottom();

    if (_latched) {
      _hasNewContent = false;
      hidePill();
    } else {
      // Show pill whenever user is scrolled away from bottom
      showPill();
    }
  }

  function isNearBottom() {
    if (!_messagesEl) return true;
    const { scrollTop, scrollHeight, clientHeight } = _messagesEl;
    return scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_THRESHOLD;
  }

  function doScrollToBottom(smooth) {
    ensureReady();
    if (!_messagesEl) return;
    if (smooth) {
      _messagesEl.scrollTo({ top: _messagesEl.scrollHeight, behavior: 'smooth' });
    } else {
      _messagesEl.scrollTop = _messagesEl.scrollHeight;
    }
  }

  function showPill() {
    if (!_pill) return;
    _pill.classList.add('visible');
    if (_badge) _badge.classList.toggle('active', _hasNewContent);
  }

  function hidePill() {
    if (!_pill) return;
    _pill.classList.remove('visible');
    if (_badge) _badge.classList.remove('active');
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Initial setup on DOMContentLoaded. */
  function init() {
    setup();
  }

  /** Re-initialize after DOM replacement (HTMX swaps, innerHTML). */
  function reinit() {
    _streaming = false;
    _latched = true;
    _hasNewContent = false;
    cleanup();
    setup();
  }

  /**
   * Force scroll to bottom — for conversation loads and HTMX swaps.
   * Always re-latches. Self-healing if DOM has been replaced.
   */
  function jumpToBottom() {
    ensureReady();
    _latched = true;
    _hasNewContent = false;
    doScrollToBottom(false);
    hidePill();
  }

  /** Streaming begins — latch to bottom. */
  function streamStart() {
    ensureReady();
    _streaming = true;
    // Don't force _latched here — jumpToBottom() already latched before streaming.
    // Respect current scroll position.
  }

  /** Content chunk arrived during streaming — scroll if latched, badge if not. */
  function streamTick() {
    if (_latched && _messagesEl) {
      _messagesEl.scrollTop = _messagesEl.scrollHeight;
    } else if (_streaming) {
      _hasNewContent = true;
      showPill();
    }
  }

  /** Streaming ended. */
  function streamEnd() {
    _streaming = false;
    if (_latched) {
      doScrollToBottom(true);
      _hasNewContent = false;
      hidePill();
    } else {
      _hasNewContent = true;
      showPill();
    }
  }

  return { init, reinit, jumpToBottom, streamStart, streamTick, streamEnd };
})();

// =============================================================================
// Lazy Message Loading — IntersectionObserver + scroll position preservation
// =============================================================================

const LazyLoader = (() => {
  const BATCH_SIZE = 50;
  let _observer = null;
  let _loading = false;
  let _conversationId = null;
  let _hasMore = false;
  let _abortController = null;

  function init(conversationId) {
    cleanup();
    _conversationId = conversationId;

    const sentinel = document.getElementById('load-earlier-sentinel');
    if (!sentinel) return;

    _hasMore = true;

    _observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !_loading && _hasMore && !isStreaming) {
          loadOlderMessages();
        }
      }
    }, {
      root: document.getElementById('messages'),
      rootMargin: '200px',
    });

    _observer.observe(sentinel);
  }

  async function loadOlderMessages() {
    if (_loading || !_hasMore || !_conversationId) return;
    _loading = true;

    const messages = document.getElementById('messages');
    const sentinel = document.getElementById('load-earlier-sentinel');
    if (!messages || !sentinel) { _loading = false; return; }

    const cursor = sentinel.dataset.oldestCreatedAt;
    const cursorId = sentinel.dataset.oldestId;

    _abortController = new AbortController();

    try {
      const params = new URLSearchParams({ limit: String(BATCH_SIZE) });
      if (cursor) params.set('before', cursor);
      if (cursorId) params.set('beforeId', cursorId);

      const response = await fetch(`/api/conversations/${_conversationId}/messages/paginated?${params}`, {
        signal: _abortController.signal,
      });
      if (!response.ok) throw new Error('Failed to load older messages');

      const { html, hasMore, oldestCreatedAt, oldestId } = await response.json();

      // Empty batch but server says there are more — update cursor and let
      // the observer re-trigger rather than killing the sentinel.
      if ((!html || html.trim() === '') && hasMore) {
        if (oldestCreatedAt) sentinel.dataset.oldestCreatedAt = oldestCreatedAt;
        if (oldestId) sentinel.dataset.oldestId = oldestId;
        _loading = false;
        return;
      }

      // No more messages and nothing to show — remove sentinel.
      if (!html || html.trim() === '') {
        _hasMore = false;
        sentinel.remove();
        _loading = false;
        return;
      }

      // Record scroll position before prepending
      const prevScrollHeight = messages.scrollHeight;
      const prevScrollTop = messages.scrollTop;

      // Parse and insert before the sentinel
      const temp = document.createElement('div');
      temp.innerHTML = html;
      const nodes = Array.from(temp.childNodes);
      const insertBefore = sentinel.nextSibling;
      for (const node of nodes) {
        messages.insertBefore(node, insertBefore);
      }

      // Adjust scroll so the user stays at the same content
      const addedHeight = messages.scrollHeight - prevScrollHeight;
      messages.scrollTop = prevScrollTop + addedHeight;

      // Update cursor for next fetch
      if (oldestCreatedAt) {
        sentinel.dataset.oldestCreatedAt = oldestCreatedAt;
      }
      if (oldestId) {
        sentinel.dataset.oldestId = oldestId;
      }

      if (!hasMore) {
        _hasMore = false;
        sentinel.style.opacity = '0';
        sentinel.style.transition = 'opacity 0.2s';
        setTimeout(() => sentinel.remove(), 200);
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('[LazyLoader] Failed to load older messages:', error);
      }
    } finally {
      _loading = false;
      _abortController = null;
    }
  }

  function cleanup() {
    if (_abortController) {
      _abortController.abort();
      _abortController = null;
    }
    if (_observer) {
      _observer.disconnect();
      _observer = null;
    }
    _loading = false;
    _conversationId = null;
    _hasMore = false;
  }

  return { init, cleanup };
})();

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Format a timestamp for display in chat message headers.
 * Shows time only for today, date + time for older messages.
 */
function formatChatTimestamp(date) {
  const tz = window.PsycherosSettings?.timezone || undefined;
  const tzOpts = tz ? { timeZone: tz } : {};
  const now = new Date();
  const isToday = tz
    ? date.toLocaleDateString('en-US', { ...tzOpts }) === now.toLocaleDateString('en-US', { ...tzOpts })
    : date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true, ...tzOpts });
  }
  return date.toLocaleDateString([], {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    ...tzOpts,
  });
}

function showToast(message, variant) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = variant === 'warning' ? 'toast toast-warning' : 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 5000);
}
// Exposed for voice.js and other modules that aren't in this file's scope.
globalThis.showToast = showToast;

// =============================================================================
// Metrics Display
// =============================================================================

/**
 * Format milliseconds as a human-readable string.
 * @param {number|null} ms - Milliseconds to format
 * @returns {string} Formatted string (e.g., "1.2s", "850ms", "-")
 */
function formatMs(ms) {
  if (ms === null || ms === undefined) return '-';
  if (ms >= 1000) {
    return (ms / 1000).toFixed(1) + 's';
  }
  return Math.round(ms) + 'ms';
}

/**
 * Get CSS class for a metric value based on thresholds.
 * @param {string} metric - Metric name
 * @param {number|null} value - Metric value
 * @returns {string} CSS class name
 */
function getMetricClass(metric, value) {
  if (value === null || value === undefined) return '';

  switch (metric) {
    case 'ttfb':
      if (value > 2000) return 'slow';
      if (value > 1000) return 'warning';
      return '';
    case 'ttfc':
      if (value > 3000) return 'slow';
      if (value > 2000) return 'warning';
      return '';
    case 'maxChunkGap':
      if (value > 1000) return 'slow';
      if (value > 500) return 'warning';
      return '';
    case 'slowChunkCount':
      if (value > 5) return 'slow';
      if (value > 0) return 'warning';
      return '';
    default:
      return '';
  }
}

// Global click listener to handle metrics tooltip toggle and close (event delegation)
document.addEventListener('click', (e) => {
  const clickedIndicator = e.target.closest('.metrics-indicator');

  if (clickedIndicator) {
    // Close all other expanded indicators
    document.querySelectorAll('.metrics-indicator.expanded').forEach(el => {
      if (el !== clickedIndicator) {
        el.classList.remove('expanded');
      }
    });
    // Toggle the clicked indicator
    clickedIndicator.classList.toggle('expanded');
    return;
  }

  // Click outside - close all expanded metrics tooltips
  document.querySelectorAll('.metrics-indicator.expanded').forEach(el => {
    el.classList.remove('expanded');
  });
});

/**
 * Create the metrics indicator element with tooltip.
 * @param {Object} metrics - The TurnMetrics object
 * @returns {HTMLElement} The metrics indicator element
 */
function createMetricsIndicator(metrics) {
  const indicator = document.createElement('div');
  indicator.className = 'metrics-indicator';

  indicator.onclick = (e) => {
    e.stopPropagation();
    // Close any other expanded indicators first
    document.querySelectorAll('.metrics-indicator.expanded').forEach(el => {
      if (el !== indicator) {
        el.classList.remove('expanded');
      }
    });
    indicator.classList.toggle('expanded');
  };

  // Summary shows total duration
  const summary = formatMs(metrics.totalDuration);

  // Build tooltip rows
  const rows = [
    { label: 'TTFB', value: metrics.ttfb, metric: 'ttfb' },
    { label: 'TTFC', value: metrics.ttfc, metric: 'ttfc' },
    { label: 'Max Gap', value: metrics.maxChunkGap, metric: 'maxChunkGap' },
    { label: 'Slow Chunks', value: metrics.slowChunkCount, metric: 'slowChunkCount', raw: true },
    { label: 'Total', value: metrics.totalDuration, metric: 'total' },
    { label: 'Chunks', value: metrics.chunkCount, metric: 'chunks', raw: true },
  ];

  const tooltipRows = rows.map(row => {
    const valueClass = getMetricClass(row.metric, row.value);
    const displayValue = row.raw ? (row.value ?? '-') : formatMs(row.value);
    return `<div class="metrics-row">
      <span class="metrics-label">${row.label}</span>
      <span class="metrics-value ${valueClass}">${displayValue}</span>
    </div>`;
  }).join('');

  indicator.innerHTML = `
    <span class="metrics-indicator-icon">&#9201;</span>
    <span class="metrics-indicator-summary">${summary}</span>
    <div class="metrics-tooltip">${tooltipRows}</div>
  `;

  return indicator;
}

// =============================================================================
// UI Containers
// =============================================================================

/**
 * Create the selection bar and modal containers on page load.
 */
function createUIContainers() {
  // Selection bar
  if (!document.getElementById('selection-bar')) {
    const bar = document.createElement('div');
    bar.id = 'selection-bar';
    bar.className = 'selection-bar';
    bar.innerHTML = `
      <span class="selection-count"><span id="selection-count-num">0</span> selected</span>
      <button class="btn btn--ghost" onclick="Psycheros.exitSelectionMode()">Cancel</button>
      <button class="btn btn--danger" onclick="Psycheros.deleteSelected()">Delete</button>
    `;
    document.body.appendChild(bar);
  }

  // Modal backdrop
  if (!document.getElementById('modal-backdrop')) {
    const backdrop = document.createElement('div');
    backdrop.id = 'modal-backdrop';
    backdrop.className = 'modal-backdrop';
    backdrop.onclick = (e) => {
      if (e.target === backdrop) closeDeleteModal();
    };
    backdrop.innerHTML = `
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-title">Delete Conversation</div>
        <div class="modal-message" id="modal-message">Are you sure you want to delete this conversation?</div>
        <div class="modal-actions">
          <button class="btn btn--ghost" onclick="Psycheros.closeDeleteModal()">Cancel</button>
          <button class="btn btn--danger" onclick="Psycheros.confirmDelete()">Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
  }
}

// =============================================================================
// Touch/Swipe Handlers
// =============================================================================

const SWIPE_THRESHOLD = 60;
const LONG_PRESS_DURATION = 500;

/**
 * Initialize touch event handlers for conversation list swipe.
 */
function initConversationTouchHandlers() {
  const convList = document.getElementById('conv-list');
  if (!convList) return;

  convList.addEventListener('touchstart', handleConvTouchStart, { passive: true });
  convList.addEventListener('touchmove', handleConvTouchMove, { passive: false });
  convList.addEventListener('touchend', handleConvTouchEnd);
  convList.addEventListener('touchcancel', handleConvTouchCancel);
}

function handleConvTouchStart(e) {
  const wrapper = e.target.closest('.conv-item-wrapper');
  if (!wrapper || selectionMode) return;

  const touch = e.touches[0];
  touchState.wrapper = wrapper;
  touchState.startX = touch.clientX;
  touchState.startY = touch.clientY;
  touchState.currentX = 0;
  touchState.isDragging = false;

  // Start long press timer for selection mode
  touchState.longPressTimer = setTimeout(() => {
    if (!touchState.isDragging && touchState.wrapper) {
      enterSelectionMode(touchState.wrapper);
      touchState.wrapper = null;
    }
  }, LONG_PRESS_DURATION);
}

function handleConvTouchMove(e) {
  if (!touchState.wrapper) return;

  const touch = e.touches[0];
  const deltaX = touch.clientX - touchState.startX;
  const deltaY = touch.clientY - touchState.startY;

  // Cancel long press if moving
  if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
    clearTimeout(touchState.longPressTimer);
  }

  // If vertical scroll is more prominent, don't start horizontal swipe
  if (!touchState.isDragging && Math.abs(deltaY) > Math.abs(deltaX)) {
    return;
  }

  // Start dragging if horizontal movement is significant
  if (!touchState.isDragging && Math.abs(deltaX) > 10) {
    touchState.isDragging = true;
    clearTimeout(touchState.longPressTimer);
  }

  if (touchState.isDragging) {
    e.preventDefault();
    touchState.currentX = deltaX;

    const convItem = touchState.wrapper.querySelector('.conv-item');
    if (convItem) {
      // Clamp the translation
      const clampedX = Math.max(-SWIPE_THRESHOLD * 1.5, Math.min(SWIPE_THRESHOLD * 1.5, deltaX));
      convItem.style.transform = `translateX(${clampedX}px)`;

      // Update swipe direction classes
      touchState.wrapper.classList.toggle('swiping-left', deltaX < -10);
      touchState.wrapper.classList.toggle('swiping-right', deltaX > 10);
    }
  }
}

function handleConvTouchEnd(_e) {
  clearTimeout(touchState.longPressTimer);

  if (!touchState.wrapper) return;

  const wrapper = touchState.wrapper;
  const convItem = wrapper.querySelector('.conv-item');
  const convId = wrapper.dataset.convId;

  if (touchState.isDragging && convItem) {
    // Reset transform with animation
    convItem.style.transform = '';
    wrapper.classList.remove('swiping-left', 'swiping-right');

    // Check if swipe was past threshold
    if (touchState.currentX > SWIPE_THRESHOLD) {
      // Swipe right - edit
      startTitleEdit(convId);
    }
    // Note: swipe-left for delete is intentionally disabled
    // to prevent accidental conversation deletion
  }

  // Reset state
  touchState.wrapper = null;
  touchState.isDragging = false;
  touchState.currentX = 0;
}

function handleConvTouchCancel() {
  clearTimeout(touchState.longPressTimer);

  if (touchState.wrapper) {
    const convItem = touchState.wrapper.querySelector('.conv-item');
    if (convItem) {
      convItem.style.transform = '';
    }
    touchState.wrapper.classList.remove('swiping-left', 'swiping-right');
  }

  touchState.wrapper = null;
  touchState.isDragging = false;
  touchState.currentX = 0;
}

// =============================================================================
// Selection Mode
// =============================================================================

/**
 * Enter selection mode, optionally selecting an initial item.
 */
function enterSelectionMode(initialWrapper = null) {
  selectionMode = true;
  selectedConversations.clear();

  const convList = document.getElementById('conv-list');
  convList?.classList.add('selection-mode');

  if (initialWrapper) {
    toggleSelection(initialWrapper);
  }

  updateSelectionBar();
}

/**
 * Exit selection mode and clear all selections.
 */
function exitSelectionMode() {
  selectionMode = false;
  selectedConversations.clear();

  const convList = document.getElementById('conv-list');
  convList?.classList.remove('selection-mode');

  // Clear all selection visual states
  document.querySelectorAll('.conv-item-wrapper.selected').forEach(el => {
    el.classList.remove('selected');
  });
  document.querySelectorAll('.conv-select-checkbox:checked').forEach(cb => {
    cb.checked = false;
  });

  updateSelectionBar();
}

/**
 * Toggle selection state for a conversation wrapper.
 */
function toggleSelection(wrapper) {
  const convId = wrapper.dataset.convId;
  if (!convId) return;

  const checkbox = wrapper.querySelector('.conv-select-checkbox');

  if (selectedConversations.has(convId)) {
    selectedConversations.delete(convId);
    wrapper.classList.remove('selected');
    if (checkbox) checkbox.checked = false;
  } else {
    selectedConversations.add(convId);
    wrapper.classList.add('selected');
    if (checkbox) checkbox.checked = true;
  }

  updateSelectionBar();

  // Auto-exit selection mode if no items selected
  if (selectedConversations.size === 0 && selectionMode) {
    exitSelectionMode();
  }
}

/**
 * Update the selection bar visibility and count.
 */
function updateSelectionBar() {
  const bar = document.getElementById('selection-bar');
  const countEl = document.getElementById('selection-count-num');

  if (bar) {
    bar.classList.toggle('visible', selectionMode && selectedConversations.size > 0);
  }
  if (countEl) {
    countEl.textContent = selectedConversations.size;
  }
}

/**
 * Delete all selected conversations.
 */
function deleteSelected() {
  if (selectedConversations.size === 0) return;
  showDeleteModal([...selectedConversations]);
}

// =============================================================================
// Delete Modal
// =============================================================================

/**
 * Show the delete confirmation modal.
 */
function showDeleteModal(ids) {
  if (!ids || ids.length === 0) return;

  pendingDeleteIds = ids;

  const backdrop = document.getElementById('modal-backdrop');
  const messageEl = document.getElementById('modal-message');

  if (messageEl) {
    const count = ids.length;
    messageEl.textContent = count === 1
      ? 'Are you sure you want to delete this conversation? This cannot be undone.'
      : `Are you sure you want to delete ${count} conversations? This cannot be undone.`;
  }

  backdrop?.classList.add('visible');
}

/**
 * Close the delete modal without deleting.
 */
function closeDeleteModal() {
  pendingDeleteIds = null;
  document.getElementById('modal-backdrop')?.classList.remove('visible');
}

/**
 * Confirm deletion of pending conversations.
 */
async function confirmDelete() {
  if (!pendingDeleteIds || pendingDeleteIds.length === 0) {
    closeDeleteModal();
    return;
  }

  const ids = [...pendingDeleteIds];
  const wasCurrentDeleted = ids.includes(currentConversationId);

  closeDeleteModal();

  try {
    let response;

    if (ids.length === 1) {
      // Single delete
      response = await fetch(`/api/conversations/${encodeURIComponent(ids[0])}`, {
        method: 'DELETE',
        headers: { 'Accept': 'application/json' },
      });
    } else {
      // Batch delete
      response = await fetch('/api/conversations', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ ids }),
      });
    }

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to delete');
    }

    // Drop any saved drafts for the deleted conversations
    for (const id of ids) {
      clearDraft(id);
    }

    // Exit selection mode if active
    if (selectionMode) {
      exitSelectionMode();
    }

    // Server broadcasts UI update via SSE - no need to manually reload

    // If current conversation was deleted, reset to home
    if (wasCurrentDeleted) {
      currentConversationId = null;
      history.pushState({}, '', '/');

      // Clear context inspector state — the conversation no longer exists
      contextSnapshots = [];
      selectedSnapshotIdx = -1;
      if (contextInspectorOpen) {
        renderContextInspector();
      }

      // Reset header title
      const headerTitle = document.getElementById('header-title');
      if (headerTitle) {
        headerTitle.textContent = 'Psycheros';
      }

      // Show empty state
      const chat = document.getElementById('chat');
      if (chat) {
        chat.innerHTML = `
          <div class="messages" id="messages">
            <div class="empty-state" id="empty-state">
              <div class="empty-title">Psycheros</div>
              <p class="empty-text">Start a new conversation or select one from the sidebar.</p>
            </div>
          </div>
          <div class="input-area">
            <div class="input-container">
              <button class="attach-btn" onclick="document.getElementById('attach-input').click()" title="Attach image">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
              </button>
              <input type="file" id="attach-input" accept="image/*" style="display:none" onchange="Psycheros.handleAttachment(this)">
              <textarea
                class="input-field"
                id="message-input"
                placeholder="Type your message..."
                rows="1"
                onkeydown="Psycheros.handleKeyDown(event)"
                oninput="Psycheros.autoResize(this)"
              ></textarea>
              <button class="send-btn" id="send-btn" onclick="Psycheros.sendMessage()">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </button>
            </div>
            <div id="attachment-preview" class="attachment-preview" style="display:none;"></div>
          </div>
        `;
      }
    }

    showToast(`Deleted ${ids.length} conversation${ids.length > 1 ? 's' : ''}`);

  } catch (error) {
    console.error('Delete failed:', error);
    showToast('Failed to delete: ' + error.message);
  }
}

// =============================================================================
// Inline Title Edit
// =============================================================================

/**
 * Start inline editing of a conversation title.
 */
function startTitleEdit(convId) {
  const wrapper = document.querySelector(`.conv-item-wrapper[data-conv-id="${convId}"]`);
  if (!wrapper) return;

  const convItem = wrapper.querySelector('.conv-item');
  const titleSpan = convItem?.querySelector('.conv-title');
  if (!titleSpan) return;

  const currentTitle = titleSpan.textContent || '';

  // Replace title span with input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'conv-title-edit';
  input.value = currentTitle;
  input.maxLength = 50;
  input.dataset.originalTitle = currentTitle;
  input.dataset.convId = convId;

  // Handle completion
  input.onblur = () => finishTitleEdit(input);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = input.dataset.originalTitle;
      input.blur();
    }
  };

  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  // Prevent click from propagating
  input.onclick = (e) => e.stopPropagation();
}

/**
 * Finish inline editing and save the title if changed.
 */
async function finishTitleEdit(input) {
  const convId = input.dataset.convId;
  const originalTitle = input.dataset.originalTitle;
  const newTitle = input.value.trim();

  // Create new title span
  const titleSpan = document.createElement('span');
  titleSpan.className = 'conv-title';
  titleSpan.textContent = newTitle || 'Untitled';

  input.replaceWith(titleSpan);

  // If title changed, update it
  if (newTitle && newTitle !== originalTitle) {
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(convId)}/title`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ title: newTitle }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update title');
      }

      // Update header title if this is the current conversation
      if (convId === currentConversationId) {
        const headerTitle = document.getElementById('header-title');
        if (headerTitle) {
          headerTitle.textContent = newTitle;
        }
      }

    } catch (error) {
      console.error('Title update failed:', error);
      showToast('Failed to update title: ' + error.message);
      // Revert to original title
      titleSpan.textContent = originalTitle || 'Untitled';
    }
  }
}

// =============================================================================
// Context Inspector
// =============================================================================

/**
 * Toggle the context inspector panel open/closed.
 */
function toggleContextViewer() {
  contextInspectorOpen = !contextInspectorOpen;
  if (contextInspectorOpen) {
    showContextInspector();
  } else {
    hideContextViewer();
  }
}

/**
 * Show the context inspector panel and load data.
 */
function showContextInspector() {
  let viewer = document.getElementById('context-viewer');
  let backdrop = document.getElementById('context-viewer-backdrop');

  if (!viewer) {
    createContextInspector();
    viewer = document.getElementById('context-viewer');
    backdrop = document.getElementById('context-viewer-backdrop');
  }

  backdrop?.classList.add('visible');
  viewer?.classList.add('visible');
  loadContextSnapshots();
}

/**
 * Hide the context inspector panel.
 */
function hideContextViewer() {
  contextInspectorOpen = false;
  document.getElementById('context-viewer')?.classList.remove('visible');
  document.getElementById('context-viewer-backdrop')?.classList.remove('visible');
}

/**
 * Fetch context snapshots from the REST API.
 */
async function loadContextSnapshots() {
  // Capture the target conversation ID at fetch time to guard against race conditions:
  // the user may switch conversations between when the fetch starts and completes.
  // Discord channel views carry their conversation ID in the DOM (data-conversation-id),
  // since currentConversationId tracks sidebar-selected conversations and is not updated
  // when navigating to Discord channels.
  const channelView = document.querySelector('.discord-channel-view');
  let targetConversationId;
  if (channelView) {
    targetConversationId = channelView.dataset.conversationId || null;
  } else {
    targetConversationId = currentConversationId;
  }

  if (!targetConversationId) {
    contextSnapshots = [];
    selectedSnapshotIdx = -1;
    renderContextInspector();
    return;
  }

  try {
    const res = await fetch(`/api/conversations/${targetConversationId}/context`);
    if (res.status === 204 || !res.ok) {
      contextSnapshots = [];
      selectedSnapshotIdx = -1;
    } else {
      contextSnapshots = await res.json();
      selectedSnapshotIdx = contextSnapshots.length > 0 ? contextSnapshots.length - 1 : -1;
    }
  } catch (e) {
    console.warn('Failed to load context snapshots:', e);
    contextSnapshots = [];
    selectedSnapshotIdx = -1;
  }

  // Discard results if the user has switched conversations during the fetch.
  const activeChannelView = document.querySelector('.discord-channel-view');
  let activeConvId;
  if (activeChannelView) {
    activeConvId = activeChannelView.dataset.conversationId || null;
  } else {
    activeConvId = currentConversationId;
  }
  if (activeConvId !== targetConversationId) return;

  renderContextInspector();
}

/**
 * Create the context inspector DOM structure.
 */
function createContextInspector() {
  const backdrop = document.createElement('div');
  backdrop.id = 'context-viewer-backdrop';
  backdrop.className = 'context-viewer-backdrop';
  backdrop.onclick = () => hideContextViewer();

  const viewer = document.createElement('div');
  viewer.id = 'context-viewer';
  viewer.className = 'context-viewer';
  viewer.onclick = (e) => e.stopPropagation();
  viewer.innerHTML = `
    <div class="context-viewer-header">
      <h2>Context Inspector</h2>
      <button class="context-viewer-close" onclick="Psycheros.hideContextViewer()">&times;</button>
    </div>
    <div class="context-turn-selector" id="context-turn-selector">
      <button class="context-turn-btn" onclick="Psycheros.contextPrevTurn()" title="Previous turn">&lsaquo;</button>
      <span class="context-turn-label" id="context-turn-label">No data</span>
      <button class="context-turn-btn" onclick="Psycheros.contextNextTurn()" title="Next turn">&rsaquo;</button>
    </div>
    <div class="context-search-bar">
      <input type="text" class="context-search" id="context-search-input"
             placeholder="Search context..." oninput="Psycheros.searchContext(this.value)">
    </div>
    <div class="context-viewer-tabs">
      <button class="context-tab active" data-tab="system">System</button>
      <button class="context-tab" data-tab="rag">RAG</button>
      <button class="context-tab" data-tab="messages">Messages</button>
      <button class="context-tab" data-tab="tools">Tools</button>
      <button class="context-tab" data-tab="plugins">Plugins</button>
      <button class="context-tab" data-tab="metrics">Metrics</button>
    </div>
    <div class="context-viewer-content" id="context-content">
      <div class="context-empty">No context data available</div>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(viewer);

  // Tab click handlers
  viewer.querySelectorAll('.context-tab').forEach(tab => {
    tab.onclick = () => switchContextTab(tab.dataset.tab);
  });
}

/**
 * Navigate to the previous snapshot.
 */
function contextPrevTurn() {
  if (selectedSnapshotIdx > 0) {
    selectedSnapshotIdx--;
    renderContextInspector();
  }
}

/**
 * Navigate to the next snapshot.
 */
function contextNextTurn() {
  if (selectedSnapshotIdx < contextSnapshots.length - 1) {
    selectedSnapshotIdx++;
    renderContextInspector();
  }
}

/**
 * Switch to a different context tab.
 */
function switchContextTab(tabName) {
  document.querySelectorAll('.context-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.context-tab[data-tab="${tabName}"]`)?.classList.add('active');
  renderContextTab(tabName);
}

/**
 * Update search query and re-render.
 */
function searchContext(query) {
  contextSearchQuery = (query || '').trim().toLowerCase();
  const activeTab = document.querySelector('.context-tab.active')?.dataset.tab || 'system';
  renderContextTab(activeTab);
}

/**
 * Render the context inspector — turn selector + active tab.
 */
function renderContextInspector() {
  // Update turn selector
  const label = document.getElementById('context-turn-label');
  if (label) {
    if (contextSnapshots.length === 0) {
      label.textContent = 'No data';
    } else {
      const snap = contextSnapshots[selectedSnapshotIdx];
      label.textContent = `Turn ${snap.turnIndex}`;
    }
  }

  const activeTab = document.querySelector('.context-tab.active')?.dataset.tab || 'system';
  renderContextTab(activeTab);
}

/**
 * Render a specific tab's content.
 */
function renderContextTab(tabName) {
  const content = document.getElementById('context-content');
  if (!content) return;

  if (contextSnapshots.length === 0 || selectedSnapshotIdx < 0) {
    content.innerHTML = '<div class="context-empty">No context data yet — send a message to populate</div>';
    return;
  }

  const snap = contextSnapshots[selectedSnapshotIdx];

  switch (tabName) {
    case 'system':
      content.innerHTML = renderSystemTab(snap);
      break;
    case 'rag':
      content.innerHTML = renderRagTab(snap);
      break;
    case 'messages':
      content.innerHTML = renderMessagesTab(snap);
      break;
    case 'tools':
      content.innerHTML = renderToolsTab(snap);
      break;
    case 'metrics':
      content.innerHTML = renderMetricsTab(snap);
      break;
    case 'plugins':
      content.innerHTML = renderPluginsTab(snap);
      break;
  }
}

/**
 * Format a character count as a human-readable size badge.
 */
function formatSizeBadge(text) {
  if (!text) return '0 chars';
  const chars = text.length;
  const tokens = countTokens(text);
  const tokenLabel = tokenizerReady ? 'tok' : '~tok';
  if (chars >= 1000) {
    return `${(chars / 1000).toFixed(1)}k chars / ${tokens.toLocaleString()} ${tokenLabel}`;
  }
  return `${chars} chars / ${tokens.toLocaleString()} ${tokenLabel}`;
}

/**
 * Apply search highlighting to text content.
 */
function highlightSearch(text) {
  if (!contextSearchQuery || !text) return escapeHtml(text || '');
  const escaped = escapeHtml(text);
  const query = escapeHtml(contextSearchQuery);
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(regex, '<mark>$1</mark>');
}

/**
 * Render a collapsible section.
 */
function renderContextSection(title, text, expanded) {
  const badge = formatSizeBadge(text);
  const content = text ? highlightSearch(text) : '<span class="context-dim">Not available</span>';
  return `
    <div class="context-section${expanded && text ? ' expanded' : ''}">
      <div class="context-section-header" onclick="this.parentElement.classList.toggle('expanded')">
        <span>${escapeHtml(title)}</span>
        <span class="context-size-badge">${badge}</span>
        <span class="context-section-toggle">&#9660;</span>
      </div>
      <div class="context-section-content">
        <pre>${content}</pre>
      </div>
    </div>
  `;
}

/**
 * Render the System tab content.
 */
function renderSystemTab(snap) {
  let html = '';
  html += renderContextSection('Base Instructions', snap.baseInstructionsContent || snap.baseInstructions, true);
  html += renderContextSection('Self Identity', snap.selfContent, true);
  html += renderContextSection('User Context', snap.userContent, true);
  html += renderContextSection('Relationship', snap.relationshipContent, true);
  html += renderContextSection('Custom', snap.customContent, true);
  html += renderContextSection('Situational Awareness', snap.situationalAwarenessContent, true);
  html += renderContextSection('Full System Message', snap.systemMessage, false);
  return html;
}

/**
 * Render the RAG tab content.
 */
function renderRagTab(snap) {
  let html = '';
  html += renderContextSection('Retrieved Memories', snap.memoriesContent, true);
  html += renderContextSection('Chat History', snap.chatHistoryContent, true);
  html += renderContextSection('Context Book Entries', snap.lorebookContent, true);
  html += renderContextSection('Data Vault', snap.vaultContent, true);
  html += renderContextSection('Knowledge Graph', snap.graphContent, true);

  const hasAny = snap.memoriesContent || snap.chatHistoryContent || snap.lorebookContent || snap.graphContent || snap.vaultContent;
  if (!hasAny) {
    html = '<div class="context-empty">No RAG context retrieved for this turn</div>';
  }
  return html;
}

/**
 * Render the Messages tab content.
 */
function renderMessagesTab(snap) {
  let messages;
  try {
    messages = JSON.parse(snap.messagesJson);
  } catch {
    return '<div class="context-empty">Failed to parse messages data</div>';
  }

  let html = `<div class="context-info">Total Messages: ${messages.length}</div>`;

  if (messages.length === 0) {
    html += '<div class="context-empty">No messages in context</div>';
    return html;
  }

  messages.forEach((msg, i) => {
    const roleClass = msg.role === 'user' ? 'role-user' : msg.role === 'assistant' ? 'role-assistant' : 'role-other';
    const contentText = msg.content || '';
    const charCount = contentText.length;
    html += `
      <div class="context-message">
        <div class="context-message-header">
          <span class="context-message-role ${roleClass}">${escapeHtml(msg.role)}</span>
          <span class="context-message-index">#${i + 1}</span>
          <span class="context-size-badge">${charCount.toLocaleString()} chars</span>
        </div>
        <div class="context-section">
          <div class="context-section-header" onclick="this.parentElement.classList.toggle('expanded')">
            <span>Content</span>
            <span class="context-section-toggle">&#9660;</span>
          </div>
          <div class="context-section-content">
            <pre class="context-message-content">${highlightSearch(contentText)}</pre>
          </div>
        </div>
        ${msg.toolCalls && msg.toolCalls.length > 0 ? `<div class="context-tool-calls">Tool Calls: ${msg.toolCalls.length}</div>` : ''}
      </div>
    `;
  });

  return html;
}

/**
 * Render the Tools tab content.
 */
function renderToolsTab(snap) {
  let tools;
  try {
    tools = JSON.parse(snap.toolDefinitionsJson);
  } catch {
    return '<div class="context-empty">Failed to parse tool definitions</div>';
  }

  let html = `<div class="context-info">Available Tools: ${tools.length}</div>`;

  if (tools.length === 0) {
    html += '<div class="context-empty">No tools available</div>';
    return html;
  }

  tools.forEach(tool => {
    const fn = tool.function || tool;
    const name = fn.name || 'unnamed';
    const desc = fn.description || '';
    const params = fn.parameters ? JSON.stringify(fn.parameters, null, 2) : '{}';
    html += `
      <div class="context-section">
        <div class="context-section-header" onclick="this.parentElement.classList.toggle('expanded')">
          <span>${escapeHtml(name)}</span>
          <span class="context-section-toggle">&#9660;</span>
        </div>
        <div class="context-section-content">
          <p class="tool-description">${escapeHtml(desc)}</p>
          <pre>${highlightSearch(params)}</pre>
        </div>
      </div>
    `;
  });

  return html;
}

/**
 * Render the Metrics tab content.
 */
function renderMetricsTab(snap) {
  let metrics;
  try {
    metrics = JSON.parse(snap.metricsJson);
  } catch {
    metrics = {};
  }

  const sections = [
    { name: 'Base Instructions', text: snap.baseInstructionsContent || snap.baseInstructions },
    { name: 'Self Identity', text: snap.selfContent },
    { name: 'User Context', text: snap.userContent },
    { name: 'Relationship', text: snap.relationshipContent },
    { name: 'Memories (RAG)', text: snap.memoriesContent },
    { name: 'Chat History (RAG)', text: snap.chatHistoryContent },
    { name: 'Lorebook', text: snap.lorebookContent },
    { name: 'Data Vault', text: snap.vaultContent },
    { name: 'Knowledge Graph', text: snap.graphContent },
    { name: 'Plugin Context', text: snap.pluginContent },
  ];

  const totalSystemChars = metrics.systemMessageLength || (snap.systemMessage || '').length;
  const totalSystemTokens = countTokens(snap.systemMessage || '');
  const estimatedTotal = metrics.estimatedTokens || totalSystemTokens;
  const contextWindow = metrics.contextLength || 128000;
  const utilizationPct = Math.min(100, Math.round((estimatedTotal / contextWindow) * 100));
  const contextLabel = (contextWindow / 1000).toFixed(0) + 'k';
  const tokenLabel = tokenizerReady ? '' : ' (est.)';

  // Plugin context budget meter — only renders when the snapshot captured it
  // (post-plugin-surface turns). Historical snapshots from before this field
  // existed just skip the row.
  let pluginBudgetRow = '';
  if (typeof metrics.pluginBudgetMax === 'number' && typeof metrics.pluginBudgetUsed === 'number') {
    const pct = metrics.pluginBudgetMax > 0
      ? Math.min(100, Math.round((metrics.pluginBudgetUsed / metrics.pluginBudgetMax) * 100))
      : 0;
    const meterColor = pct >= 90 ? 'var(--c-danger, #ff6b6b)' : (pct >= 70 ? 'var(--c-warning, #f0ad4e)' : 'var(--c-accent)');
    pluginBudgetRow = `
      <div class="context-utilization" style="margin-top:var(--sp-2);">
        <div class="context-utilization-label">Plugin Context Budget</div>
        <div class="context-utilization-bar">
          <div class="context-utilization-fill" style="width: ${pct}%;background:${meterColor};"></div>
        </div>
        <div class="context-utilization-pct">${pct}% &mdash; ${metrics.pluginBudgetUsed.toLocaleString()} / ${metrics.pluginBudgetMax.toLocaleString()} chars</div>
      </div>`;
  }

  let html = `
    <div class="context-metrics-overview">
      <div class="context-metrics-row">
        <span>System Message</span>
        <span>${totalSystemChars.toLocaleString()} chars / ${totalSystemTokens.toLocaleString()} tokens${tokenLabel}</span>
      </div>
      <div class="context-metrics-row">
        <span>Total Messages</span>
        <span>${metrics.totalMessages || '—'}${metrics.messagesTruncated ? ` (${metrics.messagesTruncated} oldest trimmed)` : ''}</span>
      </div>
      <div class="context-metrics-row">
        <span>Estimated Total Tokens</span>
        <span>~${estimatedTotal.toLocaleString()}</span>
      </div>
      <div class="context-utilization">
        <div class="context-utilization-label">Context Window (${contextLabel})</div>
        <div class="context-utilization-bar">
          <div class="context-utilization-fill" style="width: ${utilizationPct}%"></div>
        </div>
        <div class="context-utilization-pct">${utilizationPct}%</div>
      </div>
      ${pluginBudgetRow}
    </div>
    <h3 class="context-metrics-heading">Section Breakdown</h3>
    <div class="context-section-grid">
  `;

  for (const section of sections) {
    const chars = (section.text || '').length;
    const tokens = section.text ? countTokens(section.text) : 0;
    const pct = totalSystemChars > 0 ? Math.round((chars / totalSystemChars) * 100) : 0;
    html += `
      <div class="context-metrics-row">
        <span>${section.name}</span>
        <span>${chars > 0 ? `${chars.toLocaleString()} chars / ${tokens.toLocaleString()} tok (${pct}%)` : '<span class="context-dim">—</span>'}</span>
      </div>
    `;
  }

  html += '</div>';
  return html;
}

/**
 * Render the Plugins tab — per-hook detail of what each plugin prompt hook
 * contributed to the system message this turn.
 */
function renderPluginsTab(snap) {
  let metrics;
  try {
    metrics = JSON.parse(snap.metricsJson);
  } catch {
    metrics = {};
  }

  // Budget meter — shared with Metrics tab, but prominent here because this
  // tab is the "why is my plugin context only X chars?" view.
  let budgetOverview = '';
  if (typeof metrics.pluginBudgetMax === 'number' && typeof metrics.pluginBudgetUsed === 'number') {
    const pct = metrics.pluginBudgetMax > 0
      ? Math.min(100, Math.round((metrics.pluginBudgetUsed / metrics.pluginBudgetMax) * 100))
      : 0;
    const meterColor = pct >= 90 ? 'var(--c-danger, #ff6b6b)' : (pct >= 70 ? 'var(--c-warning, #f0ad4e)' : 'var(--c-accent)');
    budgetOverview = `
      <div class="context-utilization">
        <div class="context-utilization-label">Plugin Context Budget</div>
        <div class="context-utilization-bar">
          <div class="context-utilization-fill" style="width: ${pct}%;background:${meterColor};"></div>
        </div>
        <div class="context-utilization-pct">${pct}% &mdash; ${metrics.pluginBudgetUsed.toLocaleString()} / ${metrics.pluginBudgetMax.toLocaleString()} chars</div>
      </div>`;
  }

  let hooks = [];
  if (snap.pluginHooksJson) {
    try {
      hooks = JSON.parse(snap.pluginHooksJson);
    } catch {
      hooks = [];
    }
  }

  let html = `<div class="context-metrics-overview">
    <div class="context-metrics-row">
      <span>Hooks Run</span>
      <span>${hooks.length}</span>
    </div>
    ${budgetOverview}
  </div>`;

  if (hooks.length === 0) {
    html += '<div class="context-empty">No plugin prompt hooks contributed to this turn</div>';
    return html;
  }

  // Sort by priority ascending for display (matches run order).
  const sorted = [...hooks].sort((a, b) =>
    (a.priority ?? 0) - (b.priority ?? 0) ||
    (a.pluginId || '').localeCompare(b.pluginId || '') ||
    (a.hookName || '').localeCompare(b.hookName || '')
  );

  html += '<h3 class="context-metrics-heading">Per-Hook Breakdown</h3>';

  for (const h of sorted) {
    const statusBadge = renderPluginHookStatusBadge(h);
    const meta = `${h.pluginId ?? 'unknown'} &middot; priority ${h.priority ?? 0} &middot; ${h.charsUsed ?? 0} chars &middot; ${h.elapsedMs ?? 0}ms`;
    const output = h.output && h.output.length > 0
      ? highlightSearch(h.output)
      : '<span class="context-dim">No output captured</span>';
    html += `
      <div class="context-section${h.output ? ' expanded' : ''}">
        <div class="context-section-header" onclick="this.parentElement.classList.toggle('expanded')">
          <span>${escapeHtml(h.hookName || 'unnamed')} ${statusBadge}</span>
          <span class="context-size-badge">${meta}</span>
          <span class="context-section-toggle">&#9660;</span>
        </div>
        <div class="context-section-content">
          <pre>${output}</pre>
        </div>
      </div>
    `;
  }

  return html;
}

/**
 * Build a status badge for a plugin hook entry. Mirrors the tone of the
 * existing plugin health card — green fired, amber degraded, red failed/skipped.
 */
function renderPluginHookStatusBadge(h) {
  if (h.degraded) {
    return '<span class="context-tag context-tag-warn">failed</span>';
  }
  if (h.budgetSkipped) {
    return '<span class="context-tag context-tag-warn">budget-skipped</span>';
  }
  if (h.truncated) {
    return '<span class="context-tag context-tag-warn">truncated</span>';
  }
  if (!h.output || h.output.length === 0) {
    return '<span class="context-tag context-tag-dim">empty</span>';
  }
  return '<span class="context-tag context-tag-ok">fired</span>';
}

// =============================================================================
// Custom File Management
// =============================================================================

/**
 * Create a new custom file from the filename input.
 */
async function createCustomFile() {
  const input = document.getElementById('custom-filename-input');
  if (!input) {
    showToast('Input not found');
    return;
  }

  let filename = input.value.trim();
  if (!filename) {
    showToast('Please enter a filename');
    return;
  }

  // Add .md extension if not present
  if (!filename.endsWith('.md')) {
    filename = filename + '.md';
  }

  // Validate filename format (single word: letters, numbers, underscores only)
  const baseName = filename.slice(0, -3); // Remove .md
  if (!/^[a-zA-Z0-9_]+$/.test(baseName)) {
    showToast('Invalid filename. Use only letters, numbers, and underscores (no spaces).');
    return;
  }

  try {
    const response = await fetch('/api/settings/custom/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename }),
    });

    const result = await response.json();

    if (result.success) {
      showToast(`Created ${result.filename}`);
      // Clear input
      input.value = '';
      // Reload file list
      htmx.trigger('#settings-content', 'load');
      // Navigate to edit the new file
      const editUrl = `/fragments/settings/file/custom/${encodeURIComponent(result.filename)}`;
      setTimeout(() => {
        htmx.ajax('GET', editUrl, { target: '#settings-content', swap: 'innerHTML' });
      }, 100);
    } else {
      showToast(result.error || 'Failed to create file');
    }
  } catch (error) {
    console.error('Failed to create custom file:', error);
    showToast('Failed to create file');
  }
}

/**
 * Upload an identity file (core prompt) to the given directory.
 */
async function uploadIdentityFile(directory) {
  const filenameInput = document.getElementById('upload-filename-input');
  const contentInput = document.getElementById('upload-content-input');
  if (!filenameInput || !contentInput) {
    showToast('Upload form not found');
    return;
  }

  let filename = filenameInput.value.trim();
  if (!filename) {
    showToast('Please enter a file name');
    return;
  }

  // Add .md extension if not present
  if (!filename.endsWith('.md')) {
    filename = filename + '.md';
  }

  const content = contentInput.value.trim();
  if (!content) {
    showToast('Please enter file content');
    return;
  }

  try {
    const response = await fetch('/api/settings/identity/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, filename, content }),
    });

    const result = await response.json();

    if (result.success) {
      showToast(`Uploaded ${result.filename}`);
      filenameInput.value = '';
      contentInput.value = '';
      // Reload file list for this directory
      htmx.ajax('GET', `/fragments/settings/core-prompts/${directory}`, {
        target: '#settings-content',
        swap: 'innerHTML',
      });
    } else {
      showToast(result.error || 'Failed to upload file');
    }
  } catch (error) {
    console.error('Failed to upload identity file:', error);
    showToast('Failed to upload file');
  }
}

/**
 * Delete a custom file after confirmation.
 */
async function deleteCustomFile(filename) {
  if (!confirm(`Delete "${filename}"? This cannot be undone.`)) {
    return;
  }

  try {
    const response = await fetch(`/api/settings/file/custom/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
      headers: {
        'Accept': 'application/json',
      },
    });

    const result = await response.json();

    if (result.success) {
      showToast(`Deleted ${filename}`);
      // Reload file list
      htmx.ajax('GET', '/fragments/settings/core-prompts/custom', {
        target: '#settings-content',
        swap: 'innerHTML',
      });
    } else {
      showToast(result.error || 'Failed to delete file');
    }
  } catch (error) {
    console.error('Failed to delete custom file:', error);
    showToast('Failed to delete file');
  }
}

// =============================================================================
// Pulse System
// =============================================================================

/**
 * Switch between tabs in a tabbed view.
 * @param {string} section - Section name (e.g., 'pulse', 'memories')
 * @param {string} tab - Tab name (e.g., 'prompts', 'log')
 */
function switchTab(section, tab) {
  // Hide all tab contents for this section
  document.querySelectorAll(`[id^="${section}-"].tab-content`).forEach(el => {
    el.style.display = 'none';
  });

  // Show the selected tab content
  const target = document.getElementById(`${section}-${tab}`);
  if (target) target.style.display = '';

  // Update button active states
  const tabContainer = document.querySelector(`[id^="${section}-tab-"]`)?.parentElement;
  if (tabContainer) {
    tabContainer.querySelectorAll('.settings-tab').forEach(btn => {
      btn.classList.remove('active');
    });
  }
  const activeBtn = document.getElementById(`${section}-tab-${tab}`);
  if (activeBtn) activeBtn.classList.add('active');
}

/**
 * Show/hide the appropriate trigger fields based on trigger type selection.
 */
function updatePulseTriggerFields(triggerType) {
  const fields = {
    scheduled: document.getElementById('pulse-trigger-scheduled'),
    oneshot: document.getElementById('pulse-trigger-oneshot'),
    inactivity: document.getElementById('pulse-trigger-inactivity'),
    webhook: document.getElementById('pulse-trigger-webhook'),
    filesystem: document.getElementById('pulse-trigger-filesystem'),
  };

  for (const [key, el] of Object.entries(fields)) {
    if (el) el.style.display = key === triggerType ? '' : 'none';
  }

  // Desktop browsers often don't open the datetime-local picker when the
  // value is empty. Seed it with a sensible default so the field is
  // immediately editable.
  if (triggerType === 'oneshot') {
    const runAtInput = document.getElementById('pulse-run-at');
    if (runAtInput && !runAtInput.value) {
      const now = new Date();
      now.setMinutes(now.getMinutes() + 30);
      now.setSeconds(0, 0);
      const pad = (n) => String(n).padStart(2, '0');
      runAtInput.value =
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
  }
}

/**
 * Show/hide the appropriate schedule preset fields.
 */
function updatePulseSchedulePreset(preset) {
  const fields = {
    interval: document.getElementById('pulse-schedule-interval'),
    daily: document.getElementById('pulse-schedule-daily'),
    weekly: document.getElementById('pulse-schedule-weekly'),
    monthly: document.getElementById('pulse-schedule-monthly'),
    advanced: document.getElementById('pulse-schedule-advanced'),
  };

  for (const [key, el] of Object.entries(fields)) {
    if (el) el.style.display = key === preset ? '' : 'none';
  }
}

/**
 * Save a Pulse (create or update).
 * Gathers form data, translates friendly fields, sends JSON to the API.
 */
async function savePulse(event, pulseId) {
  event.preventDefault();
  const btn = document.getElementById('pulse-save-btn');
  const statusEl = document.getElementById('pulse-save-status');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Saving...';
  if (statusEl) { statusEl.className = 'settings-status visible'; statusEl.textContent = 'Saving...'; }

  try {
    const form = document.getElementById('pulse-editor-form');
    const fd = new FormData(form);
    const body = {};
    for (const [key, value] of fd.entries()) {
      if (key === 'enabled') {
        body[key] = true; // checkbox is only in FormData when checked
        continue;
      }
      if (value === '') {
        body[key] = null;
        continue;
      }
      body[key] = value;
    }

    // Checkbox for enabled: if not in FormData, it was unchecked
    if (!('enabled' in body)) body.enabled = false;

    // Checkbox for inactivity random
    body.inactivityRandom = document.getElementById('pulse-inactivity-random')?.checked || false;

    const url = pulseId ? `/api/pulses/${pulseId}` : '/api/pulses';
    const resp = await fetch(url, {
      method: pulseId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const contentType = resp.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      // Server returned the editor fragment on success
      const html = await resp.text();
      document.getElementById('chat').innerHTML = html;
      // Re-initialize schedule field visibility after DOM replacement
      const triggerType = document.getElementById('pulse-trigger-type')?.value;
      if (triggerType) updatePulseTriggerFields(triggerType);
      const schedulePreset = document.getElementById('pulse-schedule-preset')?.value;
      if (schedulePreset) updatePulseSchedulePreset(schedulePreset);
    } else {
      const data = await resp.json();
      if (statusEl) {
        statusEl.className = 'settings-status visible error';
        statusEl.textContent = data.error || 'Failed to save pulse.';
      }
    }
  } catch (e) {
    if (statusEl) {
      statusEl.className = 'settings-status visible error';
      statusEl.textContent = 'Failed to save: ' + e.message;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = pulseId ? 'Save Changes' : 'Create Pulse';
  }
}

// =============================================================================
// Graph View
// =============================================================================

let graphViewLoaded = false;

/**
 * Load and initialize the graph view.
 * Dynamically loads vis-network and graph-view.js if needed.
 */
async function loadGraphView() {
  console.log('[Psycheros] Loading graph view...');

  // Load graph-view.js if not already loaded
  if (typeof initGraph === 'undefined') {
    console.log('[Psycheros] Loading graph-view.js...');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/js/graph-view.js?v=' + Date.now();
      script.onload = () => {
        console.log('[Psycheros] graph-view.js loaded, initGraph type:', typeof initGraph);
        if (typeof initGraph === 'function') initGraph();
        resolve();
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  } else {
    // Scripts already loaded — re-initialize for the new DOM
    console.log('[Psycheros] Re-initializing graph view...');
    initGraph();
  }
}

// =============================================================================
// Device Bridge — BLE connection manager
// =============================================================================

const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // write to device
const NUS_RX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // receive from device

let deviceBridgeBLE = null; // { device, server, txChar, rxChar }
let deviceBridgeWS = null;  // WebSocket

function renderDeviceBridgeStatus() {
  const el = document.getElementById('device-bridge-status');
  if (!el) return;

  const bleConnected = deviceBridgeBLE && deviceBridgeBLE.device.gatt.connected;
  const wsConnected = deviceBridgeWS && deviceBridgeWS.readyState === WebSocket.OPEN;

  const bleDot = bleConnected
    ? '<span style="color:#4caf50;">●</span>'
    : '<span style="color:#999;">●</span>';
  const wsDot = wsConnected
    ? '<span style="color:#4caf50;">●</span>'
    : '<span style="color:#999;">●</span>';

  el.innerHTML = `
    <div style="display:flex;gap:16px;align-items:center;margin-top:8px;">
      <span>${bleDot} Bluetooth ${bleConnected ? 'Connected' : 'Disconnected'}</span>
      <span>${wsDot} Bridge ${wsConnected ? 'Connected' : 'Disconnected'}</span>
    </div>
    ${bleConnected ? `<div style="color:var(--c-fg-muted, var(--text-dim));margin-top:4px;">${deviceBridgeBLE.device.name}</div>` : ''}
  `;
}

async function connectDeviceBridge() {
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE_UUID] }],
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE_UUID);
    const txChar = await service.getCharacteristic(NUS_TX_CHAR_UUID);
    const rxChar = await service.getCharacteristic(NUS_RX_CHAR_UUID);

    deviceBridgeBLE = { device, server, txChar, rxChar };

    // Listen for inbound data from the BLE device
    await rxChar.startNotifications();
    rxChar.addEventListener('characteristicvaluechanged', (event) => {
      const value = event.target.value;
      const decoder = new TextDecoder();
      const text = decoder.decode(value);

      // Forward to server via WebSocket
      if (deviceBridgeWS && deviceBridgeWS.readyState === WebSocket.OPEN) {
        deviceBridgeWS.send(JSON.stringify({
          type: 'device_data',
          deviceId: device.id,
          dataType: 'uart',
          data: text,
        }));
      }
    });

    // Listen for disconnect
    device.addEventListener('gattserverdisconnected', () => {
      deviceBridgeBLE = null;
      renderDeviceBridgeStatus();
    });

    renderDeviceBridgeStatus();

    // Connect to the device bridge WebSocket if not already connected
    if (!deviceBridgeWS || deviceBridgeWS.readyState !== WebSocket.OPEN) {
      connectDeviceBridgeWS();
    }
  } catch (err) {
    console.error('[DeviceBridge] BLE connect failed:', err);
    renderDeviceBridgeStatus();
  }
}

function disconnectDeviceBridge() {
  if (deviceBridgeBLE) {
    deviceBridgeBLE.device.gatt.disconnect();
    deviceBridgeBLE = null;
  }
  if (deviceBridgeWS) {
    deviceBridgeWS.close();
    deviceBridgeWS = null;
  }
  renderDeviceBridgeStatus();
}

function connectDeviceBridgeWS() {
  if (deviceBridgeWS) {
    deviceBridgeWS.close();
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  deviceBridgeWS = new WebSocket(`${protocol}//${location.host}/api/device-bridge`);

  deviceBridgeWS.onopen = async () => {
    // Register our connected BLE device with the bridge.
    // Look up the configured device ID from BLE settings so the server-side
    // routing matches what tools expect (e.g. "banglejs-1" not Chrome's UUID).
    if (deviceBridgeBLE) {
      let deviceId = deviceBridgeBLE.device.id;
      let deviceName = deviceBridgeBLE.device.name || 'Unknown BLE Device';
      let deviceType = 'ble';

      try {
        const res = await fetch('/api/ble-settings');
        const settings = await res.json();
        const match = (settings.devices || []).find(d =>
          d.enabled && d.name === deviceName
        );
        if (match) {
          deviceId = match.id;
          deviceType = match.type;
        }
      } catch (e) {
        console.warn('[DeviceBridge] Could not fetch BLE settings for ID lookup:', e);
      }

      deviceBridgeWS.send(JSON.stringify({
        type: 'register',
        devices: [{ id: deviceId, name: deviceName, type: deviceType }],
      }));
    }
    renderDeviceBridgeStatus();
  };

  deviceBridgeWS.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'command' && deviceBridgeBLE && deviceBridgeBLE.txChar) {
        // Forward command to BLE device via Nordic UART
        const cmd = msg.command;
        const params = msg.params ? ' ' + JSON.stringify(msg.params) : '';
        const encoder = new TextEncoder();
        deviceBridgeBLE.txChar.writeValue(encoder.encode(cmd + params + '\n'));

        // Send success response back
        deviceBridgeWS.send(JSON.stringify({
          type: 'response',
          requestId: msg.requestId,
          success: true,
        }));

        console.log('[DeviceBridge] Sent command:', cmd);
      }
    } catch (err) {
      console.error('[DeviceBridge] Message handling failed:', err);
      // Try to send error response if we have a requestId
      try {
        const msg = JSON.parse(event.data);
        if (msg.requestId) {
          deviceBridgeWS.send(JSON.stringify({
            type: 'response',
            requestId: msg.requestId,
            success: false,
            error: err.message || String(err),
          }));
        }
      } catch {
        // Give up
      }
    }
  };

  deviceBridgeWS.onerror = () => {
    renderDeviceBridgeStatus();
  };

  deviceBridgeWS.onclose = () => {
    renderDeviceBridgeStatus();
  };

  renderDeviceBridgeStatus();
}

globalThis.connectDeviceBridge = connectDeviceBridge;
globalThis.disconnectDeviceBridge = disconnectDeviceBridge;

// =============================================================================
// Global Export
// =============================================================================

// =============================================================================
// Message Editing
// =============================================================================

/**
 * Start inline editing of a message.
 * Replaces message content with a textarea.
 */
function startMessageEdit(messageId) {
  const msgElement = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!msgElement) return;

  // Get original content — use raw markdown from data attribute when available
  let originalContent = '';
  let targetEl;

  // For assistant messages, target .assistant-text to exclude thinking/tool sections
  const assistantText = msgElement.querySelector('.assistant-text');
  if (assistantText) {
    targetEl = assistantText;
    originalContent = assistantText.dataset.rawContent || assistantText.textContent || '';
  } else {
    // For Discord entity messages, target .discord-msg-text (excludes thinking/tool sections)
    // For Discord user messages, .discord-msg-text is also used
    // For regular user messages, target .msg-content
    targetEl = msgElement.querySelector('.discord-msg-text') || msgElement.querySelector('.msg-content');
    if (!targetEl) return;
    // Fallback path: read textContent, but explicitly exclude thinking/tool
    // subtrees so the textarea never contains literal "▼ Thinking" UI text
    // (defense-in-depth for the misroute case where .assistant-text is missing).
    const clone = targetEl.cloneNode(true);
    clone.querySelectorAll('.thinking, .tool').forEach(el => el.remove());
    originalContent = targetEl.dataset.rawContent || clone.textContent || '';
  }

  // Store original content for cancel
  msgElement.dataset.originalContent = originalContent;

  // Hide the content
  targetEl.style.display = 'none';

  // Hide edit button
  const editBtn = msgElement.querySelector('.msg-edit-btn') || msgElement.querySelector('.discord-msg-edit-btn');
  if (editBtn) editBtn.style.display = 'none';

  // Create edit container
  const editContainer = document.createElement('div');
  editContainer.className = 'msg-edit-container';

  // Expand user-message bubble during editing so the textarea has room
  msgElement.classList.add('msg--editing');

  // Create textarea
  const textarea = document.createElement('textarea');
  textarea.className = 'msg-edit-textarea';
  textarea.value = originalContent;
  textarea.rows = Math.min(10, Math.max(3, originalContent.split('\n').length + 1));

  // Create actions
  const actions = document.createElement('div');
  actions.className = 'msg-edit-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn--ghost btn--sm';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => cancelMessageEdit(messageId);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn--primary btn--sm';
  saveBtn.textContent = 'Save';
  saveBtn.onclick = () => saveMessageEdit(messageId);

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);

  editContainer.appendChild(textarea);
  editContainer.appendChild(actions);

  // Insert after content
  targetEl.after(editContainer);

  // Focus textarea
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

/**
 * Cancel message edit and restore original content.
 */
function cancelMessageEdit(messageId) {
  const msgElement = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!msgElement) return;

  // Remove edit container
  const editContainer = msgElement.querySelector('.msg-edit-container');
  if (editContainer) editContainer.remove();

  // Show content (could be .assistant-text for assistant or .msg-content/.discord-msg-text for user)
  const assistantText = msgElement.querySelector('.assistant-text');
  if (assistantText) {
    assistantText.style.display = '';
  } else {
    const contentEl = msgElement.querySelector('.msg-content') || msgElement.querySelector('.discord-msg-text');
    if (contentEl) contentEl.style.display = '';
  }

  // Show edit button
  const editBtn = msgElement.querySelector('.msg-edit-btn') || msgElement.querySelector('.discord-msg-edit-btn');
  if (editBtn) editBtn.style.display = '';

  // Restore normal bubble width
  msgElement.classList.remove('msg--editing');

  // Clean up stored content
  delete msgElement.dataset.originalContent;
}

/**
 * Save message edit to server.
 */
async function saveMessageEdit(messageId) {
  const msgElement = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!msgElement) return;

  const textarea = msgElement.querySelector('.msg-edit-textarea');
  if (!textarea) return;
  if (!textarea) return;

  const newContent = textarea.value.trim();
  if (!newContent) {
    showToast('Message content cannot be empty');
    return;
  }

  // Get conversation ID — prefer DOM attribute (always correct), fall back to URL path
  let conversationId = msgElement.dataset.conversationId;
  if (!conversationId) {
    const pathParts = window.location.pathname.split('/');
    conversationId = pathParts[2]; // /c/{id}
    if (conversationId && !conversationId.match(/^[a-f0-9-]+$/)) {
      conversationId = null;
    }
  }

  if (!conversationId) {
    showToast('Cannot determine conversation ID');
    return;
  }

  // Disable save button
  const saveBtn = msgElement.querySelector('.msg-edit-actions .btn--primary');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }

  try {
    const response = await fetch(`/api/messages/${messageId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: newContent,
        conversationId,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to update message');
    }

    // For Discord messages, update in-place to preserve Discord DOM structure
    const isDiscord = msgElement.closest('.discord-channel-view') !== null;
    if (isDiscord) {
      // Update the text element's content and raw-content attribute
      const textEl = msgElement.querySelector('.discord-msg-text');
      if (textEl) {
        textEl.dataset.rawContent = newContent;
        // Simple formatting: escape HTML, highlight mentions
        textEl.innerHTML = newContent
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/&lt;@(\d+)&gt;/g, '<span class="discord-mention">@$1</span>');
      }
      // Add (edited) indicator if not already present
      if (!msgElement.querySelector('.msg-edited-indicator')) {
        const timeEl = msgElement.querySelector('.discord-msg-time');
        if (timeEl) {
          const edited = document.createElement('span');
          edited.className = 'msg-edited-indicator';
          edited.textContent = '(edited)';
          timeEl.after(edited);
        }
      }
      // Remove edit container and restore display
      cancelMessageEdit(messageId);
    } else {
      // For regular messages, replace the entire message element with updated HTML
      const updatedHtml = await response.text();
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = updatedHtml;
      const newMsgElement = tempDiv.firstElementChild;
      if (newMsgElement) {
        msgElement.replaceWith(newMsgElement);
      }
    }

    showToast('Message updated');
  } catch (error) {
    console.error('Failed to save message edit:', error);
    showToast(error instanceof Error ? error.message : 'Failed to update message');

    // Re-enable save button
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }
}

/**
 * Create a new significant memory via the API.
 */
async function createSignificantMemory() {
  const titleInput = document.getElementById('significant-title-input');
  const dateInput = document.getElementById('significant-date-input');
  const contentInput = document.getElementById('significant-content-input');
  if (!dateInput || !contentInput) {
    showToast('Form elements not found');
    return;
  }

  const title = titleInput ? titleInput.value.trim() : '';
  const date = dateInput.value.trim();
  if (!date) {
    showToast('Please select a date');
    return;
  }

  const content = contentInput.value.trim();
  if (!content) {
    showToast('Please enter memory content');
    return;
  }

  try {
    const formData = new FormData();
    formData.append('title', title);
    formData.append('date', date);
    formData.append('content', content);

    const response = await fetch('/api/memories/significant/create', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }

    // The endpoint returns HX-Redirect — reload the significant tab content
    const target = document.getElementById('settings-content');
    if (target) {
      target.innerHTML = '<div style="padding: 16px; color: var(--muted);">Loading...</div>';
      const resp = await fetch('/fragments/settings/memories/significant');
      if (resp.ok) {
        target.innerHTML = await resp.text();
      } else {
        target.reload();
      }
    }

    showToast('Significant memory created');
  } catch (error) {
    showToast('Failed to create memory: ' + error.message);
  }
}

async function deleteSignificantMemory(date) {
  if (!confirm('Delete this memory? This cannot be undone.')) {
    return;
  }

  try {
    const response = await fetch(`/api/memories/significant/${encodeURIComponent(date)}`, {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' },
    });

    const result = await response.json();

    showToast(result.success ? 'Memory deleted' : (result.error || 'Failed to delete memory'));
    htmx.ajax('GET', '/fragments/settings/memories/significant', {
      target: '#settings-content',
      swap: 'innerHTML',
    });
  } catch (error) {
    showToast('Failed to delete memory: ' + error.message);
  }
}

function goBack() {
  // Preserve whatever the user was typing before resetting the chat DOM —
  // loadConversationFromUrl restores from storage for the target conversation,
  // and the home-view branch restores the "__new__" draft below.
  saveDraft();
  if (currentConversationId) {
    loadConversationFromUrl(currentConversationId, { silent: true });
  } else {
    const chat = document.getElementById('chat');
    if (chat) {
      chat.innerHTML = `
        <div class="messages" id="messages"><div class="empty-state" id="empty-state"><div class="empty-title">Psycheros</div><p class="empty-text">What's on your mind?</p></div></div>
        <div class="input-area"><div class="input-container">
          <button class="attach-btn" onclick="document.getElementById('attach-input').click()" title="Attach image">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
            </svg>
          </button>
          <input type="file" id="attach-input" accept="image/*" style="display:none" onchange="Psycheros.handleAttachment(this)">
          <textarea class="input-field" id="message-input" placeholder="Type your message..." rows="1" onkeydown="Psycheros.handleKeyDown(event)" oninput="Psycheros.autoResize(this); Psycheros.saveDraft()"></textarea>
          <button class="send-btn" id="send-btn" onclick="Psycheros.sendMessage()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div><div id="attachment-preview" class="attachment-preview" style="display:none;"></div></div>`;
      restoreDraft();
    }
  }
}

globalThis.Psycheros = {
  toggleSidebar,
  closeSidebarAfterNav,
  goBack,
  newConversation,
  selectConversation,
  autoResize,
  saveDraft,
  handleKeyDown,
  sendMessage,
  handleAttachment,
  removeAttachment,
  retryFailedTurn,
  requestStopGeneration,
  stopGeneration,
  requestStopPulseGeneration,
  stopPulseGeneration,
  // Selection mode
  enterSelectionMode,
  exitSelectionMode,
  deleteSelected,
  // Modal
  showDeleteModal,
  closeDeleteModal,
  confirmDelete,
  // Inline edit
  startTitleEdit,
  // Message edit
  startMessageEdit,
  cancelMessageEdit,
  saveMessageEdit,
  // Tool card image caption toggle
  toggleImageCaption,
  // Context inspector
  toggleContextViewer,
  hideContextViewer,
  contextPrevTurn,
  contextNextTurn,
  searchContext,
  // Custom file management
  createCustomFile,
  deleteCustomFile,
  // Identity file upload
  uploadIdentityFile,
  // Pulse system
  switchTab,
  updatePulseTriggerFields,
  updatePulseSchedulePreset,
  savePulse,
  // Significant memory
  createSignificantMemory,
  deleteSignificantMemory,
  // Auto-scroll (for inline scripts in fragments)
  autoScrollReinit: () => AutoScroll.reinit(),
  autoScrollJump: () => AutoScroll.jumpToBottom(),
  // Voice chat
  startVoiceCall,
};

// Plugin manager functions stay global for my HTMX fragments.
function pluginManagerEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function pluginManagerBadge(label, kind) {
  return '<span class="badge ' + kind + '">' + pluginManagerEscape(label) + '</span>';
}

function pluginManagerRecord(label, record) {
  if (!record || Object.keys(record).length === 0) return '';
  const values = Object.entries(record).map(function(entry) {
    return entry[0] + ': ' + entry[1];
  }).join(', ');
  return '<p class="settings-note"><strong>' + pluginManagerEscape(label) + ':</strong> ' + pluginManagerEscape(values) + '</p>';
}

function pluginManagerList(items) {
  if (!items || items.length === 0) return '';
  return '<ul class="settings-note" style="margin-top:var(--sp-2);padding-left:var(--sp-5);">' +
    items.map(function(item) { return '<li>' + pluginManagerEscape(item) + '</li>'; }).join('') +
    '</ul>';
}

function pluginManagerCapabilities(capabilities) {
  if (!capabilities) return 'No browser changes declared';
  const labels = {
    browserScripts: 'Browser behavior',
    browserStyles: 'Browser styling',
    tools: 'Tools',
    promptHooks: 'Prompt context',
    routes: 'Local routes',
  };
  const entries = Object.entries(capabilities).filter(function(entry) {
    return Number(entry[1]) > 0;
  });
  return entries.length
    ? entries.map(function(entry) { return (labels[entry[0]] || entry[0]) + ': ' + entry[1]; }).join(', ')
    : 'No browser changes declared';
}

function pluginManagerSourceLabel(source) {
  if (!source) return 'Unknown source';
  if (source.type === 'git') {
    return 'Git: ' + source.repoUrl + (source.ref ? ' @ ' + source.ref : ' @ default branch');
  }
  return 'Zip: ' + (source.fileName || 'uploaded package');
}

async function pluginManagerJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(function() { return {}; });
  if (!response.ok || body.success === false) {
    throw new Error(body.error || 'Plugin manager request failed');
  }
  return body;
}

function renderPluginInstallReview(preview) {
  const target = document.getElementById('plugin-manager-review');
  if (!target) return;
  const manifest = preview.manifest || {};
  const caps = preview.capabilities || {};
  const warnings = preview.warnings || [];
  const existing = preview.existing;
  const pluginId = manifest.id || '';
  const pluralize = function(n, singular) {
    return n + ' ' + singular + (n === 1 ? '' : 's');
  };

  // === Capability-salience translation (Shape A) ===
  // Lead with high-stakes capabilities (prompt hooks shape what the entity
  // thinks; browser scripts can see what you type), then medium, then
  // lower-stakes. Each line is "operational language (technical detail)"
  // so a non-technical operator gets the impact and a technical one gets
  // the count.
  const stakeItems = [];
  if ((caps.promptHooks || 0) > 0) {
    stakeItems.push({
      kind: 'high',
      html: '<strong>shape what the entity thinks each turn</strong> (' +
        pluralize(caps.promptHooks, 'prompt hook') + ')',
    });
  }
  if ((caps.browserScripts || 0) > 0) {
    stakeItems.push({
      kind: 'high',
      html: '<strong>see what you type and modify what you see</strong> in this page (' +
        pluralize(caps.browserScripts, 'browser script') + ')',
    });
  }
  if ((caps.tools || 0) > 0) {
    stakeItems.push({
      kind: 'medium',
      html: 'be called by the entity to take actions (' +
        pluralize(caps.tools, 'tool') + ')',
    });
  }
  if ((caps.routes || 0) > 0) {
    stakeItems.push({
      kind: 'low',
      html: 'be reachable from the browser at <code>/api/plugins/' +
        pluginManagerEscape(pluginId) + '/...</code> (' +
        pluralize(caps.routes, 'route') + ')',
    });
  }
  if ((caps.browserStyles || 0) > 0) {
    stakeItems.push({
      kind: 'low',
      html: 'restyle parts of this page (' +
        pluralize(caps.browserStyles, 'stylesheet') + ')',
    });
  }

  // Reassuring absences — only call out high-stakes things this plugin
  // does NOT do, so the operator knows at a glance when the risk profile
  // is lower than the worst case.
  const absent = [];
  if ((caps.promptHooks || 0) === 0) {
    absent.push('cannot shape what the entity thinks (no prompt hooks)');
  }
  if ((caps.browserScripts || 0) === 0) {
    absent.push('cannot see what you type or modify what you see (no browser scripts)');
  }

  // === Update diff (Shape C) ===
  // Only manifest-declared fields are diffable here. Runtime capabilities
  // (tools/hooks/routes) for the *existing* install aren't available
  // without importing its entrypoint, which is too heavy for inspect.
  // Surface that limit honestly in the diff section.
  let diffHtml = '';
  if (existing) {
    const rows = [];
    rows.push({
      label: 'Version',
      value: '<code>' + pluginManagerEscape(existing.version) + '</code> → <code>' +
        pluginManagerEscape(manifest.version || '?') + '</code>',
    });
    const oldScripts = existing.browserScripts ?? 0;
    const newScripts = caps.browserScripts ?? 0;
    if (oldScripts !== newScripts) {
      const delta = newScripts - oldScripts;
      const sign = delta > 0 ? '+' : '';
      rows.push({
        label: 'Browser scripts',
        value: oldScripts + ' → ' + newScripts + ' <strong>(' + sign + delta + ')</strong>',
      });
    }
    const oldStyles = existing.browserStyles ?? 0;
    const newStyles = caps.browserStyles ?? 0;
    if (oldStyles !== newStyles) {
      const delta = newStyles - oldStyles;
      const sign = delta > 0 ? '+' : '';
      rows.push({
        label: 'Browser styles',
        value: oldStyles + ' → ' + newStyles + ' <strong>(' + sign + delta + ')</strong>',
      });
    }
    const oldDeps = existing.dependencies || {};
    const newDeps = preview.dependencies || {};
    const oldDepKeys = new Set(Object.keys(oldDeps));
    const newDepKeys = new Set(Object.keys(newDeps));
    const added = [...newDepKeys].filter(function(k) { return !oldDepKeys.has(k); });
    const removed = [...oldDepKeys].filter(function(k) { return !newDepKeys.has(k); });
    if (added.length || removed.length) {
      const bits = [];
      if (added.length) bits.push('+' + added.join(', +'));
      if (removed.length) bits.push('-' + removed.join(', -'));
      rows.push({ label: 'Dependencies', value: bits.join(' · ') });
    }
    diffHtml =
      '<div style="margin-top:var(--sp-4);padding-top:var(--sp-3);border-top:1px solid var(--c-border);">' +
      '<p class="settings-note" style="margin-bottom:var(--sp-2);"><strong>Replacing existing install of ' +
      pluginManagerEscape(existing.name) + '.</strong> The current version will be backed up before replace.</p>' +
      '<div class="context-section-grid">' +
      rows.map(function(r) {
        return '<div class="context-metrics-row"><span>' + pluginManagerEscape(r.label) +
          '</span><span>' + r.value + '</span></div>';
      }).join('') +
      '</div>' +
      '<p class="settings-note" style="font-size:var(--font-size-xs);margin-top:var(--sp-2);">' +
      'Manifest-field diff only. To see tool / hook / route changes, compare the plugin source between versions.</p>' +
      '</div>';
  }

  // === Source / metadata (kept but smaller) ===
  const sourceRow = '<p class="settings-note"><strong>Source:</strong> ' +
    pluginManagerEscape(pluginManagerSourceLabel(preview.source)) +
    ' · <strong>Internal ID:</strong> <code>' + pluginManagerEscape(pluginId) + '</code></p>';
  const homepageRow = manifest.homepageUrl
    ? '<p class="settings-note"><strong>Homepage:</strong> <a href="' +
      pluginManagerEscape(manifest.homepageUrl) +
      '" target="_blank" rel="noopener" style="color:var(--c-accent);">' +
      pluginManagerEscape(manifest.homepageUrl) + '</a></p>'
    : '';
  const compatRow = pluginManagerRecord('Compatibility', manifest.compatibility);
  const depsRow = pluginManagerRecord('Dependencies', preview.dependencies);
  const updateRow = manifest.update && Object.keys(manifest.update).length
    ? pluginManagerRecord('Update metadata', manifest.update)
    : '';

  // === Compose ===
  target.innerHTML = '<section class="theme-section" style="margin-bottom:0;">' +
    '<div style="display:flex;justify-content:space-between;gap:var(--sp-3);align-items:flex-start;flex-wrap:wrap;">' +
    '<div><h3 class="theme-section-title">Review ' + pluginManagerEscape(manifest.name || pluginId || 'Plugin') +
    ' <code>' + pluginManagerEscape(manifest.version || 'unknown') + '</code></h3>' +
    '<p class="theme-section-desc">' + pluginManagerEscape(manifest.description || 'A plugin manifest was found and staged for review.') + '</p></div>' +
    '<div style="display:flex;gap:var(--sp-2);flex-wrap:wrap;">' +
    pluginManagerBadge('Restart required', 'badge-primary') +
    (warnings.length ? pluginManagerBadge('Warnings', 'badge-error') : pluginManagerBadge('Ready to install', 'badge-success')) +
    '</div></div>' +

    // Capability summary — the main UX win
    '<div style="margin-top:var(--sp-3);">' +
    '<p class="settings-note" style="margin-bottom:var(--sp-1);"><strong>If installed, this plugin will:</strong></p>' +
    '<ul class="settings-note" style="margin:0 0 var(--sp-3);padding-left:var(--sp-5);">' +
    (stakeItems.length
      ? stakeItems.map(function(item) {
        return '<li>' + item.html + '</li>';
      }).join('')
      : '<li>declare itself but contribute no active capabilities</li>') +
    '</ul>' +
    (absent.length
      ? '<p class="settings-note" style="margin-bottom:var(--sp-1);"><strong>This plugin will not:</strong></p>' +
      '<ul class="settings-note" style="margin:0 0 var(--sp-3);padding-left:var(--sp-5);">' +
      absent.map(function(line) { return '<li>' + pluginManagerEscape(line) + '</li>'; }).join('') +
      '</ul>'
      : '') +
    '</div>' +

    // Update diff (only when replacing)
    diffHtml +

    // Source / metadata
    '<div style="margin-top:var(--sp-4);padding-top:var(--sp-3);border-top:1px solid var(--c-border);">' +
    sourceRow +
    homepageRow +
    compatRow +
    depsRow +
    updateRow +
    (warnings.length ? pluginManagerList(warnings) : '') +
    '</div>' +

    '<p class="settings-note" style="margin-top:var(--sp-3);">Plugins are trusted local code with full access to the entity\'s identity, memory, vault, and network. Only install if you have vetted the source.</p>' +
    '<div style="display:flex;gap:var(--sp-2);flex-wrap:wrap;margin-top:var(--sp-3);">' +
    '<button type="button" class="btn btn--primary" data-draft-id="' + pluginManagerEscape(preview.draftId) + '" onclick="installPluginDraft(this.dataset.draftId)">Install</button>' +
    '<button type="button" class="btn btn--ghost" onclick="document.getElementById(\'plugin-manager-review\').style.display=\'none\'">Cancel</button>' +
    '</div></section>';
  target.style.display = 'block';
}

async function inspectPluginZip(event) {
  event.preventDefault();
  const input = document.getElementById('plugin-zip-input');
  const button = event.submitter;
  const file = input && input.files ? input.files[0] : null;
  if (!file) {
    showToast('Select a plugin zip file to inspect');
    return;
  }
  const originalText = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Inspecting...';
  }
  try {
    const formData = new FormData();
    formData.append('plugin', file);
    const result = await pluginManagerJson('/api/plugin-manager/inspect-zip', {
      method: 'POST',
      body: formData,
    });
    renderPluginInstallReview(result.preview);
  } catch (error) {
    showToast(error.message || 'Could not inspect that plugin zip');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function inspectPluginGit(event) {
  event.preventDefault();
  const repoUrl = document.getElementById('plugin-git-url')?.value || '';
  const ref = document.getElementById('plugin-git-ref')?.value || '';
  const button = event.submitter;
  const originalText = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Inspecting...';
  }
  try {
    const result = await pluginManagerJson('/api/plugin-manager/inspect-git', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl, ref }),
    });
    renderPluginInstallReview(result.preview);
  } catch (error) {
    showToast(error.message || 'Could not inspect that plugin repository');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function refreshPluginSettings() {
  if (globalThis.htmx) {
    htmx.ajax('GET', '/fragments/settings/plugins', { target: '#chat', swap: 'innerHTML' });
    return;
  }
  fetch('/fragments/settings/plugins').then(function(response) {
    return response.text();
  }).then(function(html) {
    const chat = document.getElementById('chat');
    if (chat) chat.innerHTML = html;
  });
}

async function installPluginDraft(draftId) {
  try {
    await pluginManagerJson('/api/plugin-manager/install-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId }),
    });
    showToast('Plugin installed. Restart Psycheros before the change takes effect.');
    refreshPluginSettings();
  } catch (error) {
    showToast(error.message || 'Could not install that plugin');
  }
}

async function removePlugin(id) {
  if (!id) return;
  if (!confirm('Remove this plugin? Its code and state will be moved to plugin-backups. Plugin secrets remain available for reinstall until removed manually.')) {
    return;
  }
  try {
    await pluginManagerJson('/api/plugin-manager/plugins/' + encodeURIComponent(id), {
      method: 'DELETE',
    });
    showToast('Plugin removed. Restart Psycheros before the change takes effect.');
    refreshPluginSettings();
  } catch (error) {
    showToast(error.message || 'Could not remove that plugin');
  }
}

globalThis.inspectPluginZip = inspectPluginZip;
globalThis.inspectPluginGit = inspectPluginGit;
globalThis.installPluginDraft = installPluginDraft;
globalThis.removePlugin = removePlugin;

// =============================================================================
// Plugin Health card + per-plugin Recent Activity panel
// =============================================================================
// These load lazily after the Plugins Settings fragment swaps in. Health is
// fetched once per page render; per-plugin activity is fetched on first
// expand. No polling — refresh happens by reloading the page.

const PLUGIN_ACTIVITY_STATE = {
  // pluginId -> { filter: 'all'|'warn'|'error', lastEvents: [...] }
};

async function loadPluginHealth() {
  const target = document.getElementById('plugin-health-card');
  if (!target) return;
  let body;
  try {
    body = await pluginManagerJson('/api/plugin-manager/health');
  } catch (error) {
    target.innerHTML = '<p class="settings-note">Could not load plugin health: ' +
      pluginManagerEscape(error.message || 'unknown error') + '</p>';
    return;
  }
  const counts = body.counts || {};
  const budget = body.lastBudget;
  const denied = body.deniedEnvVars || [];

  const countRow = function(label, n, badgeKind) {
    if (!n) return '';
    return '<span style="display:inline-flex;align-items:center;gap:var(--sp-1);margin-right:var(--sp-3);">' +
      pluginManagerBadge(String(n), badgeKind) +
      '<span style="color:var(--c-fg-muted);">' + pluginManagerEscape(label) + '</span></span>';
  };

  let budgetHtml = '';
  if (budget && typeof budget.cap === 'number') {
    const pct = budget.cap > 0 ? Math.min(100, Math.round((budget.used / budget.cap) * 100)) : 0;
    const meterColor = pct >= 90 ? 'var(--c-danger, #ff6b6b)' : (pct >= 70 ? 'var(--c-warning, #f0ad4e)' : 'var(--c-accent)');
    budgetHtml =
      '<div class="context-utilization" style="margin-top:var(--sp-3);">' +
        '<div class="context-utilization-label">Plugin context budget (last turn)</div>' +
        '<div class="context-utilization-bar"><div class="context-utilization-fill" style="width:' + pct + '%;background:' + meterColor + ';"></div></div>' +
        '<div class="context-utilization-pct">' + pct + '% &mdash; ' +
          budget.used.toLocaleString() + ' / ' + budget.cap.toLocaleString() + ' chars</div>' +
      '</div>';
  }

  let deniedHtml = '';
  if (denied.length) {
    deniedHtml = '<p class="settings-note" style="margin-top:var(--sp-3);"><strong>Refused env vars:</strong> ' +
      pluginManagerEscape(denied.map(function(d) { return d.pluginId + ' (' + d.names.join(', ') + ')'; }).join('; ')) +
      '</p>';
  }

  if (counts.total === 0) {
    target.innerHTML = '<p class="settings-note">No plugins installed.</p>';
    return;
  }

  target.innerHTML =
    '<div>' +
      countRow('Active', counts.active, 'badge-success') +
      countRow('Degraded', counts.degraded, 'badge-error') +
      countRow('Pending restart', counts.pendingRestart, 'badge-primary') +
      countRow('Disabled', counts.disabled, 'badge-muted') +
      '<span style="color:var(--c-fg-muted);">of ' + counts.total + ' total</span>' +
    '</div>' +
    budgetHtml +
    deniedHtml;
}

function loadPluginVettingGuide() {
  // Retained as a no-op — the vetting guide moved to the User Guide at
  // site/src/content/docs/psycheros/user-guide.md and is linked from the
  // safety banner at the top of this page. This function is kept so the
  // afterSwap lifecycle hook below doesn't need to know whether client-side
  // vetting content exists; remove freely if the lifecycle hook is
  // simplified later.
}

async function togglePluginActivity(pluginId, button) {
  const container = document.getElementById('plugin-activity-' + pluginId);
  if (!container) return;
  const isExpanded = container.style.display !== 'none';
  if (isExpanded) {
    container.style.display = 'none';
    if (button) button.textContent = 'Show recent activity';
    return;
  }
  container.style.display = 'block';
  if (button) button.textContent = 'Hide recent activity';
  // Lazy-load on first expand; afterwards the cached render stays until
  // the user collapses/re-expands (then we re-fetch).
  if (!PLUGIN_ACTIVITY_STATE[pluginId]) {
    PLUGIN_ACTIVITY_STATE[pluginId] = { filter: 'warn' };
  }
  await loadPluginEvents(pluginId, container, PLUGIN_ACTIVITY_STATE[pluginId].filter);
}

async function loadPluginEvents(pluginId, container, filter) {
  const state = PLUGIN_ACTIVITY_STATE[pluginId] || (PLUGIN_ACTIVITY_STATE[pluginId] = { filter: 'warn' });
  state.filter = filter || 'warn';
  container.innerHTML = '<p class="settings-note">Loading…</p>';
  let body;
  try {
    body = await pluginManagerJson('/api/plugin-manager/plugins/' + encodeURIComponent(pluginId) + '/events?limit=200');
  } catch (error) {
    container.innerHTML = '<p class="settings-note">Could not load activity: ' +
      pluginManagerEscape(error.message || 'unknown error') + '</p>';
    return;
  }
  renderPluginActivity(pluginId, container, body.events || [], body.logPath || '', state.filter);
}

function renderPluginActivity(pluginId, container, events, logPath, filter) {
  const filtered = events.filter(function(e) {
    if (filter === 'all') return true;
    if (filter === 'warn') return e.level === 'warn' || e.level === 'error';
    if (filter === 'error') return e.level === 'error';
    return true;
  }).slice(-200).reverse(); // newest first

  const levelKind = function(level) {
    if (level === 'error') return 'badge-error';
    if (level === 'warn') return 'badge-primary';
    return 'badge-muted';
  };

  const eventRows = filtered.length
    ? filtered.map(function(e) {
        const ts = e.timestamp ? e.timestamp.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '';
        return '<div class="context-metrics-row" style="gap:var(--sp-2);align-items:flex-start;">' +
          '<code style="font-size:var(--font-size-xs);color:var(--c-fg-muted);white-space:nowrap;">' + pluginManagerEscape(ts) + '</code>' +
          pluginManagerBadge(e.level || '?', levelKind(e.level)) +
          '<code style="font-size:var(--font-size-xs);color:var(--c-fg-muted);">' + pluginManagerEscape(e.category) + '</code>' +
          '<span style="flex:1;word-break:break-word;">' + pluginManagerEscape(e.message || '') + '</span>' +
        '</div>';
      }).join('')
    : '<p class="settings-note">No events at this filter level.</p>';

  const filterOptions = ['warn', 'all', 'error'].map(function(value) {
    const labels = { warn: 'WARN+', all: 'All levels', error: 'ERROR only' };
    const selected = filter === value ? ' selected' : '';
    return '<option value="' + value + '"' + selected + '>' + labels[value] + '</option>';
  }).join('');

  container.innerHTML =
    '<div style="display:flex;justify-content:space-between;gap:var(--sp-2);flex-wrap:wrap;align-items:center;margin-bottom:var(--sp-2);">' +
      '<div style="display:flex;gap:var(--sp-2);align-items:center;">' +
        '<label style="font-size:var(--font-size-xs);color:var(--c-fg-muted);">Filter</label>' +
        '<select class="input-field" style="width:auto;padding:var(--sp-1);" onchange="setPluginActivityFilter(\'' +
          pluginManagerEscape(pluginId).replace(/'/g, "\\'") + '\', this.value)">' + filterOptions + '</select>' +
      '</div>' +
      '<div style="display:flex;gap:var(--sp-2);">' +
        '<button type="button" class="btn btn--ghost btn--sm" onclick="copyPluginEvents(\'' +
          pluginManagerEscape(pluginId).replace(/'/g, "\\'") + '\')">Copy</button>' +
        '<a class="btn btn--ghost btn--sm" href="/api/plugin-manager/plugins/' + encodeURIComponent(pluginId) + '/log" target="_blank" rel="noopener">Download log</a>' +
      '</div>' +
    '</div>' +
    '<p class="settings-note" style="font-size:var(--font-size-xs);">File on disk: <code>' + pluginManagerEscape(logPath) + '</code></p>' +
    '<div class="context-section-grid">' + eventRows + '</div>';
}

function setPluginActivityFilter(pluginId, filter) {
  const container = document.getElementById('plugin-activity-' + pluginId);
  if (!container) return;
  loadPluginEvents(pluginId, container, filter);
}

async function copyPluginEvents(pluginId) {
  let body;
  try {
    body = await pluginManagerJson('/api/plugin-manager/plugins/' + encodeURIComponent(pluginId) + '/events?limit=200');
  } catch (error) {
    showToast(error.message || 'Could not load events');
    return;
  }
  // Render to the same one-line-per-event text format the file uses, so a
  // paste into a support chat looks identical to downloading the file.
  const text = (body.events || []).map(function(e) {
    const ts = e.timestamp || '';
    const level = (e.level || '').toUpperCase();
    const cat = e.category || '';
    const details = e.details && Object.keys(e.details).length ? ' ' + JSON.stringify(e.details) : '';
    return '[' + ts + '] [' + level + '] [' + cat + '] ' + (e.message || '') + details;
  }).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied ' + (body.events || []).length + ' events');
  } catch {
    showToast('Clipboard blocked — use Download log instead');
  }
}

// =============================================================================
// Plugin updater — manual check + apply, no scheduler yet (v1.1 will add a
// daily task; for now operators click "Check for updates" per plugin).
// =============================================================================

async function checkPluginUpdate(pluginId, button) {
  const target = document.getElementById('plugin-update-result-' + pluginId);
  if (!target) return;
  const originalText = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Checking…';
  }
  target.innerHTML = '<p class="settings-note">Checking GitHub for newer tags…</p>';
  try {
    const body = await pluginManagerJson(
      '/api/plugin-manager/plugins/' + encodeURIComponent(pluginId) + '/check-update',
      { method: 'POST' },
    );
    renderPluginUpdateResult(pluginId, target, body.result || {});
  } catch (error) {
    target.innerHTML = '<p class="settings-note">Update check failed: ' +
      pluginManagerEscape(error.message || 'unknown error') + '</p>';
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function renderPluginUpdateResult(pluginId, target, result) {
  // Failures come back with a `reason` field — render those distinctly so
  // the operator can tell "no update available" from "check didn't run."
  if (result.reason) {
    const reasonLabel = {
      'not-configured': 'Update check not configured',
      'unsupported-host': 'Unsupported repository host',
      'network': 'Network error',
      'rate-limited': 'Rate-limited by GitHub',
      'no-valid-tags': 'No version tags found',
    }[result.reason] || 'Update check failed';
    target.innerHTML =
      '<p class="settings-note"><strong>' + pluginManagerEscape(reasonLabel) +
      ':</strong> ' + pluginManagerEscape(result.message || '') + '</p>';
    return;
  }
  if (!result.updateAvailable) {
    target.innerHTML =
      '<p class="settings-note">Up to date at <code>' +
      pluginManagerEscape(result.currentVersion || '?') + '</code>' +
      (result.latestVersion ? ' (latest tag: <code>' + pluginManagerEscape(result.latestVersion) + '</code>)' : '') +
      '.</p>';
    return;
  }
  // Update available — render the apply button inline. The tag + repoUrl
  // travel through data-attrs on the button so applyPluginUpdate has what
  // it needs without re-checking.
  target.innerHTML =
    '<div style="display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;">' +
      pluginManagerBadge('Update available', 'badge-primary') +
      '<span class="settings-note" style="margin:0;">' +
        '<code>' + pluginManagerEscape(result.currentVersion || '?') + '</code> → <code>' +
        pluginManagerEscape(result.latestVersion || '?') + '</code>' +
      '</span>' +
      '<button type="button" class="btn btn--primary btn--sm"' +
        ' data-plugin-id="' + pluginManagerEscape(pluginId) + '"' +
        ' data-tag="' + pluginManagerEscape(result.latestTag || '') + '"' +
        ' data-repo-url="' + pluginManagerEscape(result.repoUrl || '') + '"' +
        ' onclick="applyPluginUpdate(this.dataset.pluginId, this.dataset.tag, this.dataset.repoUrl, this)">' +
        'Update to ' + pluginManagerEscape(result.latestVersion || 'latest') +
      '</button>' +
    '</div>';
}

async function applyPluginUpdate(pluginId, tag, repoUrl, button) {
  if (!confirm('Apply update to ' + pluginId + ' at tag ' + tag + '?\n\nThe current install will be backed up. Psycheros will need a restart for the new version to load.')) {
    return;
  }
  const originalText = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Applying…';
  }
  try {
    await pluginManagerJson(
      '/api/plugin-manager/plugins/' + encodeURIComponent(pluginId) + '/update',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag, repoUrl }),
      },
    );
    showToast('Plugin updated. Restart Psycheros for the new version to take effect.');
    refreshPluginSettings();
  } catch (error) {
    showToast(error.message || 'Update failed');
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

globalThis.togglePluginActivity = togglePluginActivity;
globalThis.setPluginActivityFilter = setPluginActivityFilter;
globalThis.copyPluginEvents = copyPluginEvents;
globalThis.checkPluginUpdate = checkPluginUpdate;
globalThis.applyPluginUpdate = applyPluginUpdate;

/**
 * Navigate to a plugin's owned settings page. Used by the "Configure" button
 * on plugin rows. Triggers an HTMX swap into #chat, same as any other
 * settings fragment navigation.
 */
function openPluginSettings(pluginId) {
  if (!pluginId) return;
  htmx.ajax('GET', `/fragments/settings/plugins/${encodeURIComponent(pluginId)}`, {
    target: '#chat',
    swap: 'innerHTML',
  });
}
globalThis.openPluginSettings = openPluginSettings;

// Auto-load the health card and vetting guide whenever the Plugins Settings
// fragment is in the DOM. Re-runs on every HTMX swap of #chat (settings nav,
// sidebar, etc.) — loadPluginHealth/loadPluginVettingGuide early-return when
// their targets aren't present, so this is cheap when the user is elsewhere.
function initPluginsSettingsLifecycle() {
  loadPluginHealth();
  loadPluginVettingGuide();
}
initPluginsSettingsLifecycle();
document.body.addEventListener('htmx:afterSwap', function(e) {
  if (e.detail.target && e.detail.target.id === 'chat') {
    initPluginsSettingsLifecycle();
  }
});

// Show voice call button only inside an open conversation — voice needs a
// conversationId, and the button has no business on settings or other
// non-chat views. `#messages` is the conversation-view signal: it only
// exists when renderChatView() has been swapped into #chat.
function updateVoiceCallButtonVisibility() {
  fetch('/api/voice/status').then(function(r) { return r.json(); }).then(function(status) {
    var btn = document.getElementById('voice-call-btn');
    if (!btn) return;
    var inConversationView = document.getElementById('messages') !== null;
    var shouldShow = status.enabled && inConversationView;
    btn.style.display = shouldShow ? 'flex' : 'none';
  }).catch(function() {});
}

updateVoiceCallButtonVisibility();

// Re-evaluate whenever #chat is swapped via HTMX (settings nav, sidebar, etc.).
document.body.addEventListener('htmx:afterSwap', function(e) {
  if (e.detail.target && e.detail.target.id === 'chat') {
    updateVoiceCallButtonVisibility();
  }
});

/**
 * Toggle the sticky duration input when the sticky checkbox changes.
 * Used by lorebook entry create/edit forms.
 */
globalThis.toggleStickyDuration = function(checkbox) {
  const durInput = document.getElementById('entry-stickyDuration');
  if (!durInput) return;
  durInput.disabled = !checkbox.checked;
  durInput.style.opacity = checkbox.checked ? '1' : '0.5';
  durInput.style.pointerEvents = checkbox.checked ? 'auto' : 'none';
};

// =============================================================================
// Anchor Images (global functions for htmx-fragment compatibility)
// =============================================================================

globalThis.handleAnchorUpload = function() {
  const file = document.getElementById('anchor-file').files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('label', document.getElementById('anchor-label').value || 'Unnamed');
  formData.append('description', document.getElementById('anchor-upload-desc').value || '');
  fetch('/api/anchor-images', { method: 'POST', body: formData }).then(async resp => {
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showToast(err.error || 'Failed to upload anchor image');
      return;
    }
    htmx.ajax('GET', '/fragments/settings/vision', '#chat');
  });
};

globalThis.saveAnchorMeta = async function(id) {
  const card = document.getElementById('anchor-' + id);
  if (!card) return;
  const label = card.querySelector('.anchor-label').value;
  const description = card.querySelector('.anchor-desc').value;
  await fetch('/api/anchor-images/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, description }) });
};

globalThis.deleteAnchor = async function(id) {
  if (!confirm('Delete this anchor image?')) return;
  await fetch('/api/anchor-images/' + id, { method: 'DELETE' });
  htmx.ajax('GET', '/fragments/settings/vision', '#chat');
};

// =============================================================================
// Gallery (Vision)
// =============================================================================

let galleryOffset = 0;

globalThis.loadMoreGallery = function() {
  loadGallery(galleryOffset);
};

async function loadGallery(offset) {
  const container = document.getElementById('gallery-container');
  if (!container) return;

  try {
    const resp = await fetch('/api/gallery/images?offset=' + offset + '&limit=24');
    const data = await resp.json();

    galleryOffset = offset + 24;
    const esc = function(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

    const cardsHtml = data.images.map(function(img) {
      const sizeStr = img.size >= 1024 * 1024 ? (img.size / (1024 * 1024)).toFixed(1) + ' MB' : (img.size / 1024).toFixed(1) + ' KB';
      const dateStr = img.createdAt ? new Date(img.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      const shortName = img.filename.length > 20 ? img.filename.substring(0, 8) + '...' + img.filename.slice(-8) : img.filename;
      const promptAttr = img.prompt ? ' title="' + esc(img.prompt) + '"' : '';
      const catLabel = img.category === 'generated' ? 'generated' : 'uploaded';
      const catClass = img.category === 'generated' ? 'gallery-badge--generated' : 'gallery-badge--user';
      const thumbUrl = img.url.replace(/^\/(generated-images|chat-attachments)\//, '/$1/thumbs/') + '.webp';
      return '<div class="gallery-card" data-category="' + img.category + '"' + promptAttr + '>'
        + '<div class="gallery-thumb-wrap">'
        + '<img src="' + esc(thumbUrl) + '" class="gallery-thumb" loading="lazy" onclick="openLightbox(\'' + esc(img.url) + '\',\'' + esc(img.filename) + '\')"/>'
        + '<span class="gallery-badge ' + catClass + '">' + catLabel + '</span>'
        + '</div>'
        + '<div class="gallery-meta">'
        + '<span class="gallery-filename" title="' + esc(img.filename) + '">' + esc(shortName) + '</span>'
        + '<button class="gallery-copy-btn" onclick="event.stopPropagation();copyFilename(\'' + esc(img.filename) + '\',this)" title="Copy filename">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1 2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
        + '</button>'
        + '</div>'
        + '<div class="gallery-info">' + sizeStr + ' &middot; ' + dateStr + '</div>'
        + '</div>';
    }).join('');

    const grid = container.querySelector('.gallery-grid');
    if (grid) grid.insertAdjacentHTML('beforeend', cardsHtml);
    const loadMoreDiv = container.querySelector('.gallery-load-more');
    if (loadMoreDiv) loadMoreDiv.remove();
    if (data.hasMore) container.insertAdjacentHTML('beforeend', '<div class="gallery-load-more"><button class="btn btn--sm" onclick="loadMoreGallery()">Load more</button></div>');
  } catch (e) {
    console.error('Failed to load more gallery images:', e);
  }
}

globalThis.copyFilename = async function(filename, btn) {
  try {
    await navigator.clipboard.writeText(filename);
    btn.classList.add('copied');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(function() {
      btn.classList.remove('copied');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1 2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    }, 1500);
  } catch (e) {
    console.error('Failed to copy:', e);
  }
};

globalThis.openLightbox = function(url, filename) {
  closeLightbox();

  const overlay = document.createElement('div');
  overlay.className = 'gallery-lightbox';
  overlay.id = 'gallery-lightbox';
  overlay.onclick = function(e) { if (e.target === overlay) closeLightbox(); };
  overlay.innerHTML = '<button class="gallery-lightbox-close" onclick="closeLightbox()">&times;</button>'
    + '<img src="' + url + '" onclick="event.stopPropagation()"/>'
    + '<div class="gallery-lightbox-info">' + filename + '</div>';
  document.body.appendChild(overlay);
  document.addEventListener('keydown', closeLightboxOnEsc);

  // Swipe to dismiss on touch devices
  let startY = 0;
  const img = overlay.querySelector('img');
  if (img) {
    img.addEventListener('touchstart', function(e) { startY = e.touches[0].clientY; }, { passive: true });
    img.addEventListener('touchend', function(e) {
      const dy = e.changedTouches[0].clientY - startY;
      if (dy > 80) closeLightbox();
    }, { passive: true });
  }
};

function closeLightbox() {
  const overlay = document.getElementById('gallery-lightbox');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', closeLightboxOnEsc);
}
globalThis.closeLightbox = closeLightbox;

function closeLightboxOnEsc(e) {
  if (e.key === 'Escape') closeLightbox();
}

// Initialize gallery offset from server-rendered data attribute after HTMX swap
document.body.addEventListener('htmx:afterSwap', function(e) {
  const target = e.detail.target;
  if (target && target.id === 'settings-content') {
    const gc = document.getElementById('gallery-container');
    if (gc) {
      galleryOffset = parseInt(gc.getAttribute('data-gallery-offset') || '0', 10);
    }
  }
});

// =============================================================================
// Memories (Settings)
// =============================================================================

globalThis.loadMoreMemories = function(granularity, offset) {
  var container = document.getElementById('settings-content');
  if (!container) return;

  // Build URL with offset and any active date filters
  var url = '/fragments/settings/memories/' + granularity + '?offset=' + offset;
  var dateInputs = document.querySelectorAll('.memory-date-input');
  dateInputs.forEach(function(input) {
    if (input.value) url += '&' + input.name + '=' + input.value;
  });

  fetch(url)
    .then(function(resp) { return resp.text(); })
    .then(function(html) {
      var parser = new DOMParser();
      var doc = parser.parseFromString(html, 'text/html');

      // Append new items to existing list
      var newItems = doc.querySelector('.settings-file-list');
      var existingList = container.querySelector('.settings-file-list');
      if (newItems && existingList) {
        existingList.insertAdjacentHTML('beforeend', newItems.innerHTML);
        // Initialize HTMX on the newly inserted elements so hx-get etc. work
        htmx.process(existingList);
      }

      // Remove current load-more button
      var loadMoreDiv = container.querySelector('.memory-load-more');
      if (loadMoreDiv) loadMoreDiv.remove();

      // Add new load-more button if response has one
      var newLoadMore = doc.querySelector('.memory-load-more');
      if (newLoadMore) {
        container.insertAdjacentHTML('beforeend', newLoadMore.outerHTML);
      }

      // Update count
      var newCount = doc.querySelector('.memory-count');
      if (newCount) {
        var existingCount = container.querySelector('.memory-count');
        if (existingCount) existingCount.replaceWith(newCount);
      }
    })
    .catch(function(e) {
      console.error('Failed to load more memories:', e);
    });
};

// =============================================================================
// LLM Profile Edit — moved from inline script for HTMX swap reliability.
// Inline scripts in HTMX-swapped fragments don't reliably re-execute on
// subsequent swaps, so these functions live here where they persist across
// all fragment swaps.
// =============================================================================

/**
 * Read the provider presets embedded by the server as a JSON script tag.
 * Returns null if the tag isn't in the current DOM (e.g., not on the LLM page).
 */
function getLLMProviderPresets() {
  var tag = document.getElementById('llm-provider-presets-data');
  if (!tag) return null;
  try { return JSON.parse(tag.textContent); } catch { return null; }
}

var llmApiKeyVisible = false;

function toggleApiKeyVisibility() {
  var input = document.getElementById('llm-api-key');
  if (!input) return;
  llmApiKeyVisible = !llmApiKeyVisible;
  input.type = llmApiKeyVisible ? 'text' : 'password';
}

function onProviderChange() {
  var provider = document.getElementById('llm-provider').value;
  var presets = getLLMProviderPresets();
  var preset = presets ? presets[provider] : null;
  var isNew = document.getElementById('llm-is-new')?.value === 'true';
  if (preset) {
    if (preset.baseUrl) {
      document.getElementById('llm-base-url').value = preset.baseUrl;
    }
    if (preset.defaultModel && isNew) {
      document.getElementById('llm-model').value = preset.defaultModel;
    }
    if (preset.defaultWorkerModel && isNew) {
      document.getElementById('llm-worker-model').value = preset.defaultWorkerModel;
    }
    if (isNew) {
      document.getElementById('llm-name').value = preset.label;
    }
    var thinkingNote = document.getElementById('thinking-provider-note');
    if (thinkingNote) {
      thinkingNote.style.display = preset.supportsThinking ? 'none' : 'block';
    }
    document.getElementById('llm-thinking').checked = preset.supportsThinking;
    updatePersistentReasoningWarnings();
  }
}

/**
 * Show informational warnings when persistent reasoning is force-enabled
 * (intra-turn "on" or inter-turn > 0) on a provider whose preset doesn't
 * advertise supportsPersistentReasoning. The warnings never block — the
 * user is the final authority on whether their endpoint accepts the field.
 * Re-evaluated on provider change and on field change.
 */
function updatePersistentReasoningWarnings() {
  var presetsEl = document.getElementById('llm-provider-presets-data');
  var providerEl = document.getElementById('llm-provider');
  if (!presetsEl || !providerEl) return;
  try {
    var presets = JSON.parse(presetsEl.textContent || '{}');
    var provider = providerEl.value;
    var preset = presets[provider];
    var supported = preset && preset.supportsPersistentReasoning === true;

    var intraSelect = document.getElementById('llm-persistent-intra');
    var intraWarning = document.getElementById('persistent-intra-warning');
    if (intraSelect && intraWarning) {
      intraWarning.style.display =
        (intraSelect.value === 'on' && !supported) ? 'block' : 'none';
    }

    var interInput = document.getElementById('llm-persistent-inter');
    var interWarning = document.getElementById('persistent-inter-warning');
    if (interInput && interWarning) {
      var interVal = parseInt(interInput.value) || 0;
      interWarning.style.display =
        (interVal > 0 && !supported) ? 'block' : 'none';
    }
  } catch (e) {
    // Presets data missing or malformed — fail silent, warnings stay hidden.
  }
}

function gatherProfile() {
  return {
    id: document.getElementById('llm-profile-id').value || crypto.randomUUID(),
    name: document.getElementById('llm-name').value.trim() || 'Unnamed Profile',
    provider: document.getElementById('llm-provider').value,
    baseUrl: document.getElementById('llm-base-url').value.trim(),
    apiKey: document.getElementById('llm-api-key').value.trim(),
    model: document.getElementById('llm-model').value.trim(),
    workerModel: document.getElementById('llm-worker-model').value.trim(),
    temperature: parseFloat(document.getElementById('llm-temperature').value),
    topP: parseFloat(document.getElementById('llm-top-p').value),
    topK: parseInt(document.getElementById('llm-top-k').value) || 0,
    frequencyPenalty: parseFloat(document.getElementById('llm-freq-penalty').value),
    presencePenalty: parseFloat(document.getElementById('llm-pres-penalty').value),
    maxTokens: parseInt(document.getElementById('llm-max-tokens').value) || 4096,
    contextLength: parseInt(document.getElementById('llm-context-length').value) || 128000,
    thinkingEnabled: document.getElementById('llm-thinking').checked,
    persistentReasoningIntraTurn: (document.getElementById('llm-persistent-intra') || {}).value || 'auto',
    persistentReasoningInterTurns: parseInt((document.getElementById('llm-persistent-inter') || {}).value) || 0,
  };
}

function showLLMStatus(type, message) {
  var el = document.getElementById('llm-status');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'llm-status ' + type;
  el.textContent = message;
}

async function saveProfile(event) {
  var btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Saving...';
  showLLMStatus('loading', 'Saving profile...');

  try {
    var profile = gatherProfile();
    var saveResp = await fetch('/api/llm-settings/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    var data = await saveResp.json();
    if (data.success) {
      htmx.ajax('GET', '/fragments/settings/llm', { target: '#chat', swap: 'innerHTML' });
    } else {
      showLLMStatus('error', 'Failed to save: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showLLMStatus('error', 'Failed to save: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Profile';
  }
}

async function testProfileConnection() {
  var btn = document.getElementById('test-connection-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Testing...';
  showLLMStatus('loading', 'Sending test request...');

  try {
    var profile = gatherProfile();
    var resp = await fetch('/api/llm-settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    var data = await resp.json();
    if (data.success) {
      showLLMStatus('success', 'Connection successful! (' + data.latency + 'ms)');
    } else {
      showLLMStatus('error', 'Connection failed: ' + (data.error || 'Unknown error') + (data.latency ? ' (' + data.latency + 'ms)' : ''));
    }
  } catch (e) {
    showLLMStatus('error', 'Connection failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}

async function setAsActive(profileId) {
  showLLMStatus('loading', 'Switching active profile...');
  try {
    var resp = await fetch('/api/llm-settings/set-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
    var data = await resp.json();
    if (data.success) {
      htmx.ajax('GET', '/fragments/settings/llm', { target: '#chat', swap: 'innerHTML' });
    } else {
      showLLMStatus('error', 'Failed to switch: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showLLMStatus('error', 'Failed to switch: ' + e.message);
  }
}

async function deleteProfile(profileId) {
  var btn = document.getElementById('delete-profile-btn');
  if (!btn) return;
  if (!btn.dataset.confirming) {
    btn.dataset.confirming = 'true';
    btn.textContent = 'Confirm Delete?';
    btn.classList.add('btn--danger');
    btn.classList.remove('btn--ghost');
    setTimeout(function() {
      if (btn.dataset.confirming) {
        delete btn.dataset.confirming;
        btn.textContent = 'Delete Profile';
        btn.classList.remove('btn--danger');
        btn.classList.add('btn--ghost');
      }
    }, 3000);
    return;
  }
  delete btn.dataset.confirming;
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  showLLMStatus('loading', 'Deleting profile...');

  try {
    var resp = await fetch('/api/llm-settings', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    var settings = await resp.json();

    if (settings.profiles.length <= 1) {
      showLLMStatus('error', 'Cannot delete the only profile.');
      btn.disabled = false;
      btn.textContent = 'Delete Profile';
      btn.classList.remove('btn--danger');
      btn.classList.add('btn--ghost');
      return;
    }

    settings.profiles = settings.profiles.filter(function(p) { return p.id !== profileId; });
    if (settings.activeProfileId === profileId) {
      settings.activeProfileId = settings.profiles[0].id;
    }

    var saveResp = await fetch('/api/llm-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    var data = await saveResp.json();
    if (data.success) {
      htmx.ajax('GET', '/fragments/settings/llm', { target: '#chat', swap: 'innerHTML' });
    } else {
      showLLMStatus('error', 'Failed to delete: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showLLMStatus('error', 'Failed to delete: ' + e.message);
  }
}

/**
 * Initialize the LLM profile edit form after HTMX swap.
 * Sets up provider note visibility based on the current provider.
 */
function initLLMProfileEdit() {
  if (!document.getElementById('llm-provider')) return; // not on the profile edit page
  var presets = getLLMProviderPresets();
  var provider = document.getElementById('llm-provider').value;
  var preset = presets ? presets[provider] : null;
  var thinkingNote = document.getElementById('thinking-provider-note');
  if (thinkingNote && preset) {
    thinkingNote.style.display = preset.supportsThinking ? 'none' : 'block';
  }
}

// Re-initialize after HTMX swaps the profile edit form
document.body.addEventListener('htmx:afterSwap', function(e) {
  if (e.detail.target?.id === 'chat') {
    initLLMProfileEdit();
  }
});

// Also initialize on DOMContentLoaded for full page loads
document.addEventListener('DOMContentLoaded', initLLMProfileEdit);

// Expose LLM profile functions to global scope for onclick handlers in HTML.
// psycheros.js is loaded as a module, so top-level declarations are module-scoped.
globalThis.toggleApiKeyVisibility = toggleApiKeyVisibility;
globalThis.onProviderChange = onProviderChange;
globalThis.saveProfile = saveProfile;
globalThis.testProfileConnection = testProfileConnection;
globalThis.updatePersistentReasoningWarnings = updatePersistentReasoningWarnings;
globalThis.setAsActive = setAsActive;
globalThis.deleteProfile = deleteProfile;

// =============================================================================
// External Connections — moved from inline script for HTMX swap reliability.
// Inline scripts in HTMX-swapped fragments don't reliably re-execute on
// subsequent swaps, so these functions live here where they persist across
// all fragment swaps.
// =============================================================================

// --- Tab switching ---

function switchConnectionsTab(tab) {
  document.querySelectorAll('.connections-nav-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.querySelectorAll('.connections-tab-panel').forEach(function(p) {
    p.style.display = p.id === 'connections-tab-' + tab ? '' : 'none';
  });
  // Start/stop BLE status polling when switching to/from BLE tab
  if (tab === 'ble') {
    startBLEStatusPolling();
  } else {
    stopBLEStatusPolling();
  }
}

// --- Web Search ---

function showWsStatus(type, message) {
  var el = document.getElementById('ws-status');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'llm-status ' + type;
  el.textContent = message;
}

function getSelectedProvider() {
  var checked = document.querySelector('input[name="ws-provider"]:checked');
  return checked ? checked.value : 'disabled';
}

async function saveWebSearchSettings(event) {
  var btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Saving...';
  showWsStatus('loading', 'Saving settings...');

  try {
    var settings = {
      provider: getSelectedProvider(),
      tavilyApiKey: document.getElementById('ws-tavily-key')?.value.trim() || '',
      braveApiKey: document.getElementById('ws-brave-key')?.value.trim() || '',
    };
    var resp = await fetch('/api/web-search-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    var data = await resp.json();
    if (data.success) {
      showWsStatus('success', 'Settings saved successfully.');
    } else {
      showWsStatus('error', 'Failed to save: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showWsStatus('error', 'Failed to save: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Settings';
  }
}

var wsResetPending = false;

async function resetWebSearchDefaults(event) {
  var btn = event.currentTarget;
  if (!wsResetPending) {
    wsResetPending = true;
    btn.textContent = 'Confirm Reset?';
    btn.classList.add('btn--danger');
    btn.classList.remove('btn--ghost');
    setTimeout(function() {
      if (wsResetPending) {
        wsResetPending = false;
        btn.textContent = 'Reset to Defaults';
        btn.classList.remove('btn--danger');
        btn.classList.add('btn--ghost');
      }
    }, 3000);
    return;
  }
  wsResetPending = false;
  btn.textContent = 'Resetting...';
  btn.disabled = true;
  showWsStatus('loading', 'Resetting to defaults...');

  try {
    var resp = await fetch('/api/web-search-settings/reset', { method: 'POST' });
    var data = await resp.json();
    if (data.success) {
      htmx.ajax('GET', '/fragments/settings/connections', { target: '#chat', swap: 'innerHTML' });
    } else {
      showWsStatus('error', 'Failed to reset: ' + (data.error || 'Unknown error'));
      btn.disabled = false;
      btn.textContent = 'Reset to Defaults';
      btn.classList.remove('btn--danger');
      btn.classList.add('btn--ghost');
    }
  } catch (e) {
    showWsStatus('error', 'Failed to reset: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Reset to Defaults';
    btn.classList.remove('btn--danger');
    btn.classList.add('btn--ghost');
  }
}

// --- BLE Device Management ---

/** XML name validation: must start with letter/underscore, then letters/digits/hyphens/underscores/periods. */
var XML_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;

function addBLEDeviceRow() {
  var list = document.getElementById('ble-devices-list');
  if (!list) return;
  var tmpl = document.getElementById('ble-blank-device-row');
  if (!tmpl) return;
  var clone = tmpl.content.cloneNode(true);
  list.appendChild(clone);
}

function showBLEDevicesStatus(type, msg) {
  var el = document.getElementById('ble-devices-status');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'llm-status ' + type;
  el.textContent = msg;
}

async function saveBLEDevices() {
  var rows = document.querySelectorAll('#ble-devices-list .ble-device-row');
  var devices = [];
  var errors = [];

  rows.forEach(function(row) {
    var id = (row.querySelector('[data-field="id"]')?.value || '').trim();
    var name = (row.querySelector('[data-field="name"]')?.value || '').trim();
    var type = (row.querySelector('[data-field="type"]')?.value || 'ble').trim();
    var enabled = row.querySelector('[data-field="enabled"]')?.checked ?? true;
    if (!id) return;

    // Collect stream configs from the collapsible section
    var streams = {};
    row.querySelectorAll('[data-stream-id]').forEach(function(el) {
      var streamId = el.dataset.streamId;
      if (!streams[streamId]) streams[streamId] = {};
      if (el.dataset.streamField === 'xmlTag') {
        var tagVal = el.value.trim() || streamId;
        if (!XML_NAME_RE.test(tagVal)) {
          errors.push('Invalid XML tag "' + tagVal + '" for stream ' + streamId +
            ': must start with a letter or underscore, followed by letters, digits, hyphens, underscores, or periods.');
        }
        streams[streamId].xmlTag = tagVal;
      } else if (el.dataset.streamField === 'enabled') {
        streams[streamId].enabled = el.checked;
      }
    });
    // Fill in labels from the span next to each stream
    row.querySelectorAll('[data-stream-id][data-stream-field="xmlTag"]').forEach(function(el) {
      var streamId = el.dataset.streamId;
      var labelSpan = el.closest('div')?.querySelector('span');
      if (labelSpan && streams[streamId]) {
        streams[streamId].label = labelSpan.textContent.trim();
      }
    });

    devices.push({
      id: id,
      name: name,
      type: type,
      enabled: enabled,
      ...(Object.keys(streams).length > 0 ? { streams: streams } : {}),
    });
  });

  if (errors.length > 0) {
    showBLEDevicesStatus('error', errors[0]);
    return;
  }

  showBLEDevicesStatus('loading', 'Saving devices...');
  try {
    var resp = await fetch('/api/ble-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices: devices }),
    });
    var data = await resp.json();
    if (data.success) {
      showBLEDevicesStatus('success', 'Devices saved.');
    } else {
      showBLEDevicesStatus('error', 'Failed: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showBLEDevicesStatus('error', 'Failed: ' + e.message);
  }
}

// --- BLE Connection Status Polling ---

var bleStatusInterval = null;

function startBLEStatusPolling() {
  stopBLEStatusPolling();
  updateBLEStatusBadges(); // immediate check
  bleStatusInterval = setInterval(updateBLEStatusBadges, 5000);
}

function stopBLEStatusPolling() {
  if (bleStatusInterval) {
    clearInterval(bleStatusInterval);
    bleStatusInterval = null;
  }
}

async function updateBLEStatusBadges() {
  try {
    var resp = await fetch('/api/ble-status');
    if (!resp.ok) return;
    var data = await resp.json();
    var connectedIds = data.connectedIds || [];
    // Update badges on both BLE settings (ble-device-row) and SA settings (llm-field) pages
    document.querySelectorAll('[data-device-id]').forEach(function(container) {
      var badge = container.querySelector('.ble-status-badge');
      if (!badge) return;
      var isConnected = connectedIds.indexOf(container.dataset.deviceId) !== -1;
      badge.textContent = isConnected ? 'Connected' : 'Disconnected';
      badge.style.background = isConnected ? 'rgba(76,175,80,0.15)' : 'rgba(158,158,158,0.15)';
      badge.style.color = isConnected ? '#4CAF50' : '#9E9E9E';
    });
  } catch (_) {
    // Silently ignore — polling will retry
  }
}

// --- Web Search Radio Initialization ---

function initWebSearchRadios() {
  var radios = document.querySelectorAll('input[name="ws-provider"]');
  if (radios.length === 0) return; // not on the connections page
  radios.forEach(function(radio) {
    // Remove old listener by cloning (simple dedup)
    var clone = radio.cloneNode(true);
    radio.parentNode.replaceChild(clone, radio);
    clone.addEventListener('change', function() {
      var tavily = document.getElementById('ws-tavily-section');
      var brave = document.getElementById('ws-brave-section');
      if (!tavily || !brave) return;
      tavily.style.display = clone.value === 'tavily' ? '' : 'none';
      brave.style.display = clone.value === 'brave' ? '' : 'none';
    });
  });
}

// Re-initialize after HTMX swaps the connections or SA settings page
document.body.addEventListener('htmx:afterSwap', function(e) {
  if (e.detail.target?.id === 'chat') {
    initWebSearchRadios();
    // Start BLE status polling on SA settings page (has wearable data section)
    if (document.querySelector('[data-sa-device]')) {
      startBLEStatusPolling();
    } else if (!document.getElementById('connections-tab-ble')) {
      stopBLEStatusPolling();
    }
  }
});

// Also initialize on DOMContentLoaded for full page loads
document.addEventListener('DOMContentLoaded', function() {
  initWebSearchRadios();
  // Start BLE status polling on SA settings page for full page loads
  if (document.querySelector('[data-sa-device]')) {
    startBLEStatusPolling();
  }
});

// --- SA Settings ---

async function saveSASettings() {
  var enabledEl = document.getElementById('sa-enabled');
  var enabled = enabledEl ? enabledEl.checked : true;

  // Collect wearable stream toggles
  var streamToggles = {};
  document.querySelectorAll('[data-sa-device][data-sa-stream]').forEach(function(el) {
    var deviceId = el.dataset.saDevice;
    var streamId = el.dataset.saStream;
    var checked = el.checked;
    if (!streamToggles[deviceId]) streamToggles[deviceId] = {};
    streamToggles[deviceId][streamId] = { enabled: checked };
  });

  try {
    var res = await fetch('/api/sa-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled, streamToggles: streamToggles }),
    });
    var data = await res.json();
    var el = document.getElementById('sa-settings-status');
    if (!el) return;
    if (data.success) {
      el.className = 'settings-status visible success';
      el.textContent = 'Settings saved successfully';
      setTimeout(function() { el.className = 'settings-status'; }, 3000);
    } else {
      el.className = 'settings-status visible error';
      el.textContent = data.error || 'Failed to save settings';
      setTimeout(function() { el.className = 'settings-status'; }, 3000);
    }
  } catch (e) {
    var el = document.getElementById('sa-settings-status');
    if (el) {
      el.className = 'settings-status visible error';
      el.textContent = 'Failed to save settings';
      setTimeout(function() { el.className = 'settings-status'; }, 3000);
    }
  }
}

// Expose External Connections + SA functions to global scope for onclick handlers.
globalThis.switchConnectionsTab = switchConnectionsTab;
globalThis.addBLEDeviceRow = addBLEDeviceRow;
globalThis.showBLEDevicesStatus = showBLEDevicesStatus;
globalThis.saveBLEDevices = saveBLEDevices;
globalThis.showWsStatus = showWsStatus;
globalThis.saveWebSearchSettings = saveWebSearchSettings;
globalThis.resetWebSearchDefaults = resetWebSearchDefaults;
globalThis.saveSASettings = saveSASettings;

// =============================================================================
// Event Rules (Webhooks)
// =============================================================================

function switchSATab(tab) {
  var signalsPanel = document.getElementById('sa-panel-signals');
  var webhooksPanel = document.getElementById('sa-panel-webhooks');
  var signalsTab = document.getElementById('sa-tab-signals');
  var webhooksTab = document.getElementById('sa-tab-webhooks');
  if (!signalsPanel || !webhooksPanel || !signalsTab || !webhooksTab) return;

  if (tab === 'signals') {
    signalsPanel.style.display = '';
    webhooksPanel.style.display = 'none';
    signalsTab.classList.add('sa-tab--active');
    webhooksTab.classList.remove('sa-tab--active');
  } else {
    signalsPanel.style.display = 'none';
    webhooksPanel.style.display = '';
    signalsTab.classList.remove('sa-tab--active');
    webhooksTab.classList.add('sa-tab--active');
  }
}

function addEventRule() {
  var list = document.getElementById('event-rules-list');
  var template = document.getElementById('event-rule-blank-row');
  if (!list || !template) return;
  var clone = template.content.cloneNode(true);
  list.appendChild(clone);
}

function deleteEventRule(button) {
  var card = button.closest('.event-rule-card');
  if (!card) return;
  var ruleId = card.dataset.ruleId;
  if (ruleId) {
    fetch('/api/event-rules/' + ruleId, { method: 'DELETE' })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.success) card.remove();
      })
      .catch(function() {});
  } else {
    card.remove();
  }
}

async function saveEventRules() {
  var cards = document.querySelectorAll('.event-rule-card');
  var statusEl = document.getElementById('event-rules-status');

  for (var i = 0; i < cards.length; i++) {
    var el = cards[i];
    var ruleId = el.dataset.ruleId;
    var enabled = el.querySelector('[data-rule-enabled]')?.checked ?? true;
    var name = el.querySelector('[data-rule-name]')?.value;
    var streamId = el.querySelector('[data-cond-stream]')?.value;
    var operator = el.querySelector('[data-cond-operator]')?.value;
    var rawValue = el.querySelector('[data-cond-value]')?.value;
    var sustainedRaw = el.querySelector('[data-cond-sustained]')?.value;
    var pulseId = el.querySelector('[data-action-pulse]')?.value;
    var cooldownMin = parseInt(el.querySelector('[data-rule-cooldown]')?.value || '5', 10);

    if (!name || !streamId || !operator || rawValue === undefined || rawValue === '' || !pulseId) {
      if (statusEl) {
        statusEl.className = 'settings-status visible error';
        statusEl.textContent = 'All fields are required for each webhook rule';
        setTimeout(function() { statusEl.className = 'settings-status'; }, 3000);
      }
      return;
    }

    var value = isNaN(Number(rawValue)) ? rawValue : Number(rawValue);
    var condition = { streamId: streamId, operator: operator, value: value };
    if (sustainedRaw && parseInt(sustainedRaw, 10) > 0) {
      condition.sustainedMinutes = parseInt(sustainedRaw, 10);
    }

    var rule = {
      name: name,
      enabled: enabled,
      condition: condition,
      action: { pulseId: pulseId },
      cooldownMinutes: cooldownMin,
    };

    try {
      var method = ruleId ? 'PUT' : 'POST';
      var url = ruleId ? '/api/event-rules/' + ruleId : '/api/event-rules';
      var res = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rule),
      });
      var data = await res.json();
      if (!data.success) {
        if (statusEl) {
          statusEl.className = 'settings-status visible error';
          statusEl.textContent = data.error || 'Failed to save webhook';
          setTimeout(function() { statusEl.className = 'settings-status'; }, 3000);
        }
        return;
      }
      // Update the DOM element with the new ID for subsequent saves
      if (!ruleId && data.rule?.id) {
        el.dataset.ruleId = data.rule.id;
      }
    } catch (e) {
      if (statusEl) {
        statusEl.className = 'settings-status visible error';
        statusEl.textContent = 'Failed to save webhook';
        setTimeout(function() { statusEl.className = 'settings-status'; }, 3000);
      }
      return;
    }
  }

  if (statusEl) {
    statusEl.className = 'settings-status visible success';
    statusEl.textContent = 'Webhooks saved successfully';
    setTimeout(function() { statusEl.className = 'settings-status'; }, 3000);
  }
}

globalThis.switchSATab = switchSATab;
globalThis.addEventRule = addEventRule;
globalThis.deleteEventRule = deleteEventRule;
globalThis.saveEventRules = saveEventRules;

// =============================================================================
// Voice chat debug panel
// =============================================================================
// General-purpose diagnostic panel for the voice chat pipeline. Captures:
//   - Mic permission flow (Tauri invoke + getUserMedia probe)
//   - WebSocket connection lifecycle (open/close/error)
//   - Walkie-talkie state transitions
//   - TTS frame arrival + decode errors
//   - AudioContext setup + sample-rate mismatches
// Useful for: macOS desktop mic issues, STT/TTS pipeline debugging,
// diagnosing audio glitches (pops, dropouts, format mismatches).
//
// Log entries come from two sources:
//   1. The "Run test" button below (one-shot probe of env + mic + audio + WS)
//   2. voice.js during a real voice chat (live events tagged by category)
// Both routes funnel through appendVoiceDebug(category, message) so the
// panel shows a unified timeline.
//
// State is in-memory; reload clears the log. Intentional — debug sessions
// are short-lived and stale logs would confuse users.

const voiceChatDebugLog = [];

function appendVoiceDebug(category, message) {
  const prefix = category ? `[${category}]` : '';
  const line = `[${new Date().toISOString()}] ${prefix} ${message}`.trim();
  voiceChatDebugLog.push(line);
  // Also surface in the browser console so debug works even when the
  // settings panel isn't open. Tagged the same way for grep-ability.
  console.log(`[voice:${category || 'debug'}] ${message}`);
  const textarea = document.getElementById('voice-chat-debug-log');
  if (textarea) {
    textarea.value = voiceChatDebugLog.join('\n');
    textarea.scrollTop = textarea.scrollHeight;
  }
}

function toggleVoiceChatDebugPanel() {
  // Legacy no-op stub — kept for any cached page that still calls the
  // old name. The real toggle is toggleVoiceChatDebug(checked) below.
  const checkbox = document.getElementById('voice-chat-debug');
  const panel = document.getElementById('voice-chat-debug-panel');
  if (!checkbox || !panel) return;
  panel.style.display = checkbox.checked ? '' : 'none';
}

async function toggleVoiceChatDebug(checked) {
  // Show/hide the panel immediately for responsiveness, then persist.
  const panel = document.getElementById('voice-chat-debug-panel');
  if (panel) panel.style.display = checked ? '' : 'none';
  try {
    const resp = await fetch('/api/voice/settings');
    const settings = await resp.json();
    settings.voiceChatDebug = checked;
    const saveResp = await fetch('/api/voice/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const result = await saveResp.json();
    if (result.success) {
      showToast(checked ? 'Voice chat debug enabled' : 'Voice chat debug disabled');
    } else {
      showToast('Failed: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (e) {
    showToast('Failed: ' + e.message, 'error');
  }
}

function clearVoiceChatDebugLog() {
  voiceChatDebugLog.length = 0;
  const textarea = document.getElementById('voice-chat-debug-log');
  if (textarea) textarea.value = '';
}

async function copyVoiceChatDebugLog(btn) {
  const text = voiceChatDebugLog.join('\n');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  } catch (err) {
    console.warn('[voice:debug] copy failed:', err);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = 'Copy failed — select manually';
      setTimeout(() => { btn.textContent = original; }, 2000);
    }
  }
}

async function runVoiceChatTest() {
  appendVoiceDebug('test', '=== Voice chat test started ===');
  appendVoiceDebug('env', `URL: ${window.location.href}`);
  appendVoiceDebug('env', `User agent: ${navigator.userAgent}`);
  appendVoiceDebug('env', `Secure context: ${window.isSecureContext}`);
  const tauriKeys = Object.keys(window).filter((k) => k.toLowerCase().includes('tauri'));
  appendVoiceDebug('env', `window keys containing 'tauri': ${tauriKeys.join(', ') || 'none'}`);

  // --- Native mic-capture plugin probe (Tauri desktop only) ---
  // The plugin streams Int16 PCM frames via a Tauri IPC Channel. We
  // start it, count frames for 2 seconds, then stop. Expected ~100
  // frames at 50Hz (20ms each at 16kHz mono Int16).
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const TauriChannel = window.__TAURI__?.core?.Channel;
  appendVoiceDebug('mic-perm', `window.__TAURI__.core.invoke available: ${!!tauriInvoke}`);
  appendVoiceDebug('mic-perm', `window.__TAURI__.core.Channel available: ${!!TauriChannel}`);

  if (tauriInvoke && TauriChannel) {
    const channel = new TauriChannel('audio-frame-test');
    let frameCount = 0;
    let firstFrameBytes = 0;
    let firstFrameShape = 'unknown';
    let maxRms = 0;
    let minRms = -1;
    channel.onmessage = (message) => {
      frameCount++;
      let bytes = null;
      if (message instanceof ArrayBuffer) {
        bytes = new Uint8Array(message);
        if (frameCount === 1) {
          firstFrameBytes = message.byteLength;
          firstFrameShape = 'ArrayBuffer';
        }
      } else if (Array.isArray(message)) {
        bytes = new Uint8Array(message);
        if (frameCount === 1) {
          firstFrameBytes = message.length;
          firstFrameShape = 'Array';
        }
      } else if (message && typeof message.length === 'number') {
        bytes = message;
        if (frameCount === 1) {
          firstFrameBytes = message.length;
          firstFrameShape = message.constructor?.name || 'TypedArray';
        }
      } else if (frameCount === 1) {
        firstFrameBytes = 0;
        firstFrameShape = typeof message;
      }
      if (bytes && bytes.length >= 2) {
        let sumSq = 0;
        const sampleCount = bytes.length >> 1;
        for (let j = 0; j < bytes.length - 1; j += 2) {
          let val = bytes[j] | (bytes[j + 1] << 8);
          if (val > 32767) val -= 65536;
          const n = val / 32768;
          sumSq += n * n;
        }
        const rms = Math.sqrt(sumSq / Math.max(sampleCount, 1));
        if (rms > maxRms) maxRms = rms;
        if (rms < minRms || minRms < 0) minRms = rms;
      }
    };
    appendVoiceDebug('mic-perm', "Calling invoke('plugin:psycheros-mic-capture|start_capture')...");
    try {
      await tauriInvoke('plugin:psycheros-mic-capture|start_capture', { onFrame: channel });
      appendVoiceDebug('mic-perm', 'start_capture returned OK — listening for 2 seconds');
      await new Promise((r) => setTimeout(r, 2000));
      await tauriInvoke('plugin:psycheros-mic-capture|stop_capture');
      appendVoiceDebug(
        'mic-perm',
        `native capture OK — ${frameCount} frames in 2s (first frame: ${firstFrameBytes} bytes, shape: ${firstFrameShape}, RMS range: ${minRms.toFixed(4)}–${maxRms.toFixed(4)})`,
      );
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      appendVoiceDebug('mic-perm', `native capture FAILED: ${detail}`);
      // Best-effort stop in case start succeeded but something else failed
      try {
        await tauriInvoke('plugin:psycheros-mic-capture|stop_capture');
      } catch {}
    }
  } else {
    appendVoiceDebug('mic-perm', 'Skipping native capture probe — not in desktop app context or no Channel API');
  }

  // --- getUserMedia probe ---
  // Differentiate the two failure modes so we know whether the whole
  // mediaDevices surface is missing or just getUserMedia:
  //   - "navigator.mediaDevices is undefined" → API surface missing entirely
  //   - "mediaDevices present but getUserMedia undefined" → surface exists,
  //     just the capture method is gated (different fix)
  if (typeof navigator.mediaDevices === 'undefined') {
    appendVoiceDebug('mic', 'navigator.mediaDevices is undefined — entire API surface missing');
    appendVoiceDebug('mic', `navigator.mediaDevices type: ${typeof navigator.mediaDevices}`);
    // Also enumerate any media-related navigator keys we can see.
    const mediaKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(navigator)).filter(
      (k) => k.toLowerCase().includes('media') || k.toLowerCase().includes('audio'),
    );
    appendVoiceDebug('mic', `navigator prototype media/audio keys: ${mediaKeys.join(', ') || 'none'}`);
  } else if (typeof navigator.mediaDevices.getUserMedia !== 'function') {
    appendVoiceDebug('mic', `navigator.mediaDevices present but getUserMedia is ${typeof navigator.mediaDevices.getUserMedia} (expected function)`);
    appendVoiceDebug('mic', `mediaDevices keys: ${Object.keys(navigator.mediaDevices).join(', ')}`);
  } else {
    appendVoiceDebug('mic', 'Probing navigator.mediaDevices.getUserMedia...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tracks = stream.getTracks();
      appendVoiceDebug('mic', `getUserMedia succeeded — ${tracks.length} track(s)`);
      tracks.forEach((t) => {
        appendVoiceDebug('mic', `  track: label="${t.label}" kind=${t.kind} enabled=${t.enabled}`);
        const settings = t.getSettings ? t.getSettings() : {};
        appendVoiceDebug('mic', `  settings: sampleRate=${settings.sampleRate ?? 'n/a'} channelCount=${settings.channelCount ?? 'n/a'} echoCancellation=${settings.echoCancellation ?? 'n/a'}`);
        t.stop();
      });
    } catch (err) {
      const detail = err && err.name ? `${err.name}: ${err.message || 'no message'}` : String(err);
      appendVoiceDebug('mic', `getUserMedia FAILED: ${detail}`);
    }
  }

  // --- AudioContext probe (catches sample-rate mismatches that cause pops) ---
  appendVoiceDebug('audio', 'Probing AudioContext...');
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      appendVoiceDebug('audio', 'AudioContext API NOT available');
    } else {
      const ctx = new AC();
      await ctx.resume().catch(() => {});
      appendVoiceDebug('audio', `AudioContext state=${ctx.state} sampleRate=${ctx.sampleRate} baseLatency=${ctx.baseLatency ?? 'n/a'}${ctx.outputLatency ? ' outputLatency=' + ctx.outputLatency : ''}`);
      // Play a 200ms soft sine pulse to confirm output routing works.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.05;
      osc.frequency.value = 440;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      setTimeout(() => { try { osc.stop(); ctx.close(); } catch {} }, 250);
      appendVoiceDebug('audio', 'Test tone scheduled (440Hz, 200ms, 5% gain) — should hear a soft beep');
    }
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    appendVoiceDebug('audio', `AudioContext FAILED: ${detail}`);
  }

  // --- Voice endpoint probe (catches routing/proxy/auth issues) ---
  appendVoiceDebug('ws', 'Probing /api/voice/status endpoint...');
  try {
    // Use a relative URL so it inherits the page's protocol + host —
    // fetch needs http/https, not ws/wss. Earlier versions built the
    // URL with the WS scheme which silently failed with "Failed to fetch".
    const resp = await fetch('/api/voice/status', { headers: { 'Accept': 'application/json' } });
    appendVoiceDebug('ws', `GET /api/voice/status → ${resp.status} ${resp.statusText}`);
    if (resp.ok) {
      const body = await resp.json().catch(() => null);
      appendVoiceDebug('ws', `voice status: ${JSON.stringify(body)}`);
    }
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    appendVoiceDebug('ws', `voice status probe FAILED: ${detail}`);
  }

  appendVoiceDebug('test', '=== Test complete ===');
}

globalThis.appendVoiceDebug = appendVoiceDebug;
globalThis.toggleVoiceChatDebugPanel = toggleVoiceChatDebugPanel;
globalThis.toggleVoiceChatDebug = toggleVoiceChatDebug;
globalThis.clearVoiceChatDebugLog = clearVoiceChatDebugLog;
globalThis.copyVoiceChatDebugLog = copyVoiceChatDebugLog;
globalThis.runVoiceChatTest = runVoiceChatTest;

// =============================================================================
// Embedding Settings (Model Settings > Embeddings tab)
// =============================================================================

/**
 * Read the active repo id from the dropdown or custom-repo field.
 */
function getActiveEmbeddingRepoId() {
  const sel = document.getElementById('embedding-preset');
  if (!sel) return '';
  if (sel.value === '__custom__') {
    const custom = document.getElementById('embedding-custom-repo');
    return custom ? normalizeRepoId(custom.value.trim()) : '';
  }
  return sel.value;
}

/**
 * Accept either a bare repo id ("BAAI/bge-small-en-v1.5") or a full
 * huggingface URL and normalize to the repo id form.
 */
function normalizeRepoId(input) {
  if (!input) return '';
  const stripped = input.replace(/^https?:\/\/(www\.)?huggingface\.co\//i, '');
  return stripped.replace(/\/$/, '').trim();
}

/**
 * Read embedded JSON blobs.
 */
function readEmbeddingData() {
  const presetsJson = document.getElementById('embedding-presets-data');
  const downloadedJson = document.getElementById('embedding-downloaded-data');
  const activeJson = document.getElementById('embedding-active-data');
  let presets = [];
  let downloaded = [];
  let active = { modelRepoId: '', dimension: 0, downloaded: false, downloadSizeMb: null };
  try {
    if (presetsJson) presets = JSON.parse(presetsJson.textContent || '[]');
  } catch (err) { console.warn('parse presets', err); }
  try {
    if (downloadedJson) downloaded = JSON.parse(downloadedJson.textContent || '[]');
  } catch (err) { console.warn('parse downloaded', err); }
  try {
    if (activeJson) active = JSON.parse(activeJson.textContent || '{}');
  } catch (err) { console.warn('parse active', err); }
  return { presets, downloaded, active };
}

/**
 * Refresh the inline download button / "downloaded" badge to match the
 * currently-selected model. Called on dropdown change and on custom-repo
 * input (debounced).
 */
function refreshDownloadUi() {
  const { presets, downloaded } = readEmbeddingData();
  const repoId = getActiveEmbeddingRepoId();
  const preset = presets.find((p) => p.repoId === repoId);
  const isDownloaded = downloaded.includes(repoId);

  const inlineWrap = document.getElementById('embedding-download-inline');
  const badge = document.getElementById('embedding-downloaded-badge');
  const nameLabel = document.getElementById('embedding-download-name');
  const statusEl = document.getElementById('embedding-download-status');

  if (isDownloaded) {
    if (inlineWrap) inlineWrap.style.display = 'none';
    if (badge) {
      badge.style.display = '';
      badge.innerHTML = `✓ <strong>${
        escapeHtmlClient(preset?.label ?? repoId)
      }</strong> is downloaded and ready.`;
    }
  } else {
    if (badge) badge.style.display = 'none';
    if (inlineWrap) {
      inlineWrap.style.display = '';
      if (nameLabel) {
        nameLabel.textContent = preset?.label ?? repoId ?? '(set repo ID)';
      }
      // The "(XXMB)" suffix is part of the button text node — swap it.
      const btn = inlineWrap.querySelector('button');
      if (btn) {
        const sizeText = preset ? ` (${preset.downloadSizeMb}MB)` : '';
        // Rebuild: ↓ Download <name> <size>
        btn.innerHTML = `↓ Download <span id="embedding-download-name">${
          escapeHtmlClient(preset?.label ?? repoId ?? '(set repo ID)')
        }</span>${sizeText}`;
      }
    }
    if (statusEl) statusEl.textContent = '';
  }
}

/**
 * Dropdown onchange: show/hide custom row, refresh download UI, update
 * recommended chunk size hints.
 */
function onEmbeddingPresetChange(value) {
  const customRow = document.getElementById('embedding-custom-row');
  if (customRow) customRow.style.display = value === '__custom__' ? '' : 'none';

  // Clear the hint for custom repos — will be filled by probeCustomRepoDimension.
  if (value === '__custom__') {
    setRecommendedHint(null, '');
  } else {
    try {
      const { presets } = readEmbeddingData();
      const preset = presets.find((p) => p.repoId === value);
      if (preset) {
        setRecommendedHint(preset.recommendedChunkTargetChars, preset.label);
      }
    } catch (err) {
      console.warn('rec update failed', err);
    }
  }

  refreshDownloadUi();
  updateSaveButtonLabel();
}
globalThis.onEmbeddingPresetChange = onEmbeddingPresetChange;

/**
 * Custom repo input handler — debounced dimension probe + UI refresh.
 */
let customRepoDebounce = null;
function onCustomRepoInput(value) {
  if (customRepoDebounce) clearTimeout(customRepoDebounce);
  customRepoDebounce = setTimeout(() => {
    refreshDownloadUi();
    updateSaveButtonLabel();
    if (value) probeCustomRepoDimension(normalizeRepoId(value));
  }, 500);
}
globalThis.onCustomRepoInput = onCustomRepoInput;

/**
 * Render the recommended-chunk-size hint under "Target chars". Pass null to
 * hide it (e.g. custom repo before probe completes).
 */
function setRecommendedHint(value, modelLabel) {
  const container = document.querySelector('[data-rec-container="targetChars"]');
  if (!container) return;
  if (value === null || value === undefined) {
    container.textContent = '';
    return;
  }
  const label = modelLabel || 'this model';
  container.textContent = `(Recommended for ${label}: ${value})`;
}

/**
 * Probe a custom HF repo's dimension + context length. Updates the
 * recommended chunk-size hint using the probed context length
 * (capped at 8192 chars by the server).
 */
async function probeCustomRepoDimension(repoId) {
  if (!repoId || !repoId.includes('/')) {
    setRecommendedHint(null);
    return;
  }
  const hint = document.getElementById('embedding-custom-dimension');
  if (hint) hint.textContent = 'Probing dimension...';
  try {
    const resp = await fetch('/api/embedding-settings/probe-dimension', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (hint) hint.textContent = `Error: ${data.error || resp.status}`;
      setRecommendedHint(null);
      return;
    }
    const ctxInfo = data.maxContextTokens
      ? ` — ${data.maxContextTokens}-token context`
      : '';
    if (hint) hint.textContent = `Dimension: ${data.dimension}${ctxInfo}`;
    // Use the probed recommended value if the server returned one;
    // otherwise hide the hint so we don't show a misleading number.
    if (data.recommendedChunkTargetChars !== null && data.recommendedChunkTargetChars !== undefined) {
      setRecommendedHint(data.recommendedChunkTargetChars, repoId);
    } else {
      setRecommendedHint(null);
    }
  } catch (err) {
    if (hint) hint.textContent = `Error: ${err.message || err}`;
    setRecommendedHint(null);
  }
}

/**
 * Start a download for the currently-selected model.
 */
async function downloadEmbeddingModel() {
  const repoId = getActiveEmbeddingRepoId();
  if (!repoId) {
    alert('Select a model first.');
    return;
  }
  const statusEl = document.getElementById('embedding-download-status');
  if (statusEl) statusEl.textContent = `Starting download for ${repoId}...`;
  try {
    await fetch('/api/embedding-settings/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId }),
    });
    pollDownloadStatus(repoId);
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err.message || err}`;
  }
}
globalThis.downloadEmbeddingModel = downloadEmbeddingModel;

/**
 * Subscribe to the download SSE stream.
 */
function pollDownloadStatus(repoId) {
  const statusEl = document.getElementById('embedding-download-status');
  const btn = document.querySelector('#embedding-download-inline button');
  // Swap the button for a spinner + "Downloading..." label so the user
  // gets clear feedback even when the progress percent is unreliable
  // (Xenova's progress callback fires inconsistently for some files).
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="admin-action-spinner"></span> Downloading...';
  }
  if (statusEl) statusEl.innerHTML = '';

  const es = new EventSource(
    `/api/embedding-settings/download-status?repoId=${encodeURIComponent(repoId)}`,
  );
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.state === 'ready') {
        markRepoDownloaded(repoId);
        if (statusEl) {
          statusEl.innerHTML = `<span class="embedding-download-success">✓ Download complete — ready to switch</span>`;
        }
        es.close();
        refreshDownloadUi();
        setTimeout(() => {
          const status = document.getElementById('embedding-download-status');
          if (status) status.innerHTML = '';
        }, 4000);
      } else if (data.state === 'error') {
        if (statusEl) {
          statusEl.innerHTML = `<span class="embedding-download-error">✗ Error: ${data.error || 'unknown'}</span>`;
        }
        if (btn) { btn.disabled = false; btn.textContent = 'Download'; }
        es.close();
      }
      // Ignore 'downloading' state — the spinner already conveys it.
    } catch (err) {
      console.warn('download SSE parse error', err);
    }
  };
  es.onerror = () => {
    es.close();
    if (btn) { btn.disabled = false; btn.textContent = 'Download'; }
  };
}

/**
 * Patch the in-memory downloaded list to include the just-downloaded repo.
 * The page-embedded JSON is static from server render time, so without this
 * refreshDownloadUi wouldn't know about new downloads in the same session.
 */
function markRepoDownloaded(repoId) {
  const downloadedJson = document.getElementById('embedding-downloaded-data');
  if (!downloadedJson) return;
  try {
    const list = JSON.parse(downloadedJson.textContent || '[]');
    if (!list.includes(repoId)) {
      list.push(repoId);
      downloadedJson.textContent = JSON.stringify(list);
    }
  } catch (err) {
    console.warn('markRepoDownloaded parse failed', err);
  }
}

/**
 * Compute the form state and detect whether saving would require re-embedding.
 */
function gatherEmbeddingForm() {
  const repoId = getActiveEmbeddingRepoId();
  const chunkParams = {};
  document.querySelectorAll('[data-chunk-param]').forEach((el) => {
    const key = el.getAttribute('data-chunk-param');
    const v = el.value;
    if (key && v !== '') chunkParams[key] = parseInt(v, 10);
  });
  return { modelRepoId: repoId, chunkParams };
}

/**
 * Compare current form state to the originally-loaded active model +
 * chunk params. Returns true if saving would trigger a re-embed.
 */
function wouldReembed() {
  const { active } = readEmbeddingData();
  // System out of sync (e.g. previous re-embed failed) → always re-embed.
  if (active.outOfSync) return true;
  const form = gatherEmbeddingForm();
  if (!form.modelRepoId || form.modelRepoId !== active.modelRepoId) return true;
  // We don't have the original chunk params client-side, so any change to
  // a chunk-param field is treated as a potential re-embed trigger.
  const changedChunks = Array.from(document.querySelectorAll('[data-chunk-param]'))
    .some((el) => el.dataset.original && el.value !== el.dataset.original);
  return changedChunks;
}

/**
 * Update the save button label to reflect whether re-embed will be needed.
 * Also surfaces a warning when the system is out of sync (saved settings
 * don't match what the daemon actually has loaded).
 */
function updateSaveButtonLabel() {
  const btn = document.getElementById('embedding-save-btn');
  if (!btn) return;
  // Always "Save & Re-embed" — saving always triggers a re-embed, even if
  // the form looks unchanged, to handle cases where the system is out of
  // sync with the saved settings.
  btn.textContent = 'Save & Re-embed';
  // Toggle a visible warning when saved != running.
  const { active } = readEmbeddingData();
  let warning = document.getElementById('embedding-sync-warning');
  if (active.outOfSync) {
    if (!warning) {
      warning = document.createElement('div');
      warning.id = 'embedding-sync-warning';
      warning.className = 'embedding-sync-warning';
      btn.parentNode.insertBefore(warning, btn.nextSibling);
    }
    warning.innerHTML = `<strong>System out of sync:</strong> saved model is ${
      active.dimension
    }d but the daemon is running ${active.actualDimension}d. Click Save &amp; Re-embed to align.`;
  } else if (warning) {
    warning.remove();
  }
}

/**
 * Save settings. If the change requires a re-embed, confirm with the user
 * via a native confirm() dialog, then kick off the orchestrator with a
 * blocking overlay + inline progress.
 */
async function saveEmbeddingSettings() {
  const form = gatherEmbeddingForm();
  if (!form.modelRepoId) {
    alert('Select a model first.');
    return;
  }

  // Check download state for the selected model.
  const { downloaded } = readEmbeddingData();
  if (!downloaded.includes(form.modelRepoId)) {
    if (!confirm(
      `The selected model "${form.modelRepoId}" is not downloaded yet.\n\n` +
        `Click OK to download it first (you'll see a progress indicator), ` +
        `then come back and click Save again. Click Cancel to abort.`
    )) {
      return;
    }
    await downloadEmbeddingModel();
    return;
  }

  // Always confirm — saving always triggers a full re-embed, even if the
  // form looks unchanged, because the underlying system may be out of sync
  // with the saved settings (e.g. a previous re-embed failed mid-run).
  const ok = confirm(
    `Save these settings and re-embed all memories, messages, vault ` +
      `documents, and graph nodes with the selected model?\n\n` +
      `This may take several minutes. The chat will be unavailable during ` +
      `re-indexing. Do not close this page.`
  );
  if (!ok) return;

  const btn = document.getElementById('embedding-save-btn');
  const statusEl = document.getElementById('embedding-save-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  if (statusEl) statusEl.textContent = '';

  try {
    // Persist the settings first.
    const resp = await fetch('/api/embedding-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.error || 'Failed to save');
    }
    // Then kick off the orchestrator unconditionally.
    await runReembedWithProgress(btn, statusEl);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save & Re-embed'; }
    if (statusEl) statusEl.textContent = `Error: ${err.message || err}`;
    alert(`Error: ${err.message || err}`);
  }
}
globalThis.saveEmbeddingSettings = saveEmbeddingSettings;

/**
 * Kick off the re-embed orchestrator and show blocking progress UI.
 */
async function runReembedWithProgress(btn, statusEl) {
  const progressSection = document.getElementById('embedding-reembed-progress');
  const progressFill = document.getElementById('embedding-reembed-progress-fill');
  const progressText = document.getElementById('embedding-reembed-progress-text');
  const overlay = document.getElementById('embedding-reembed-overlay');

  if (progressSection) progressSection.style.display = '';
  if (progressFill) progressFill.style.width = '0%';
  if (progressText) progressText.textContent = 'Preparing...';
  if (overlay) overlay.style.display = '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="admin-action-spinner"></span> Re-embedding...'; }
  if (statusEl) statusEl.textContent = '';

  try {
    const resp = await fetch('/api/embedding-settings/confirm-reembed', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.error || 'Failed to start re-embed');
    }
    subscribeReembedProgress(btn, statusEl);
  } catch (err) {
    if (progressText) progressText.textContent = `Error: ${err.message || err}`;
    if (overlay) overlay.style.display = 'none';
    if (btn) { btn.disabled = false; btn.textContent = 'Save & Re-embed'; }
  }
}

/**
 * Subscribe to re-embed SSE progress stream.
 */
function subscribeReembedProgress(btn, statusEl) {
  const fill = document.getElementById('embedding-reembed-progress-fill');
  const text = document.getElementById('embedding-reembed-progress-text');
  const overlay = document.getElementById('embedding-reembed-overlay');
  let lastPhase = '';
  const logLines = [];
  const es = new EventSource('/api/embedding-settings/reembed-status');
  es.onmessage = (ev) => {
    try {
      const s = JSON.parse(ev.data);
      const pct = Math.round((s.progress || 0) * 100);
      if (fill) fill.style.width = `${pct}%`;

      // Append a new line when the phase changes or when a progress
      // message arrives (e.g. "Re-embedding messages: 23/51").
      const phaseLabel = formatPhase(s.phase);
      const msg = s.message ? ` — ${s.message}` : '';
      const line = `${phaseLabel}${msg}`;
      if (line !== logLines[logLines.length - 1]) {
        logLines.push(line);
      }
      if (text) {
        text.innerHTML = logLines.map((l) => `<div>${escapeHtmlClient(l)}</div>`).join('');
      }

      if (s.phase === 'complete') {
        es.close();
        if (text) {
          text.innerHTML += '<div><strong>✓ Re-embed complete.</strong></div>';
        }
        // Hide the blocking overlay + re-enable the button so the user
        // stays on the settings page. Refresh just the tab content via
        // HTMX so the sync warning clears — no full-page reload.
        if (overlay) overlay.style.display = 'none';
        if (btn) { btn.disabled = false; btn.textContent = 'Save & Re-embed'; }
        if (statusEl) statusEl.textContent = '✓ Re-embed complete.';
        setTimeout(() => {
          if (window.htmx) {
            window.htmx.ajax('GET', '/fragments/settings/llm/embeddings', '#chat');
          }
        }, 1000);
      } else if (s.phase === 'error') {
        es.close();
        if (text) {
          text.innerHTML += `<div><strong>✗ Error: ${escapeHtmlClient(s.error || 'unknown')}</strong></div>`;
        }
        if (overlay) overlay.style.display = 'none';
        if (btn) { btn.disabled = false; btn.textContent = 'Save & Re-embed'; }
        if (statusEl) statusEl.textContent = `Error: ${s.error || 'unknown'}`;
      }
    } catch (err) {
      console.warn('reembed SSE parse error', err);
    }
  };
  es.onerror = () => es.close();
}

function formatPhase(phase) {
  const map = {
    'idle': 'Idle',
    'preparing': 'Preparing',
    'dropping-psycheros': 'Resetting vector tables',
    'reindexing-psycheros-messages': 'Re-embedding messages',
    'reindexing-psycheros-memories': 'Re-embedding memory chunks',
    'reindexing-psycheros-vault': 'Re-embedding vault documents',
    'triggering-entity-core': 'Rebuilding entity-core',
    'persisting': 'Saving settings',
    'complete': 'Complete',
    'error': 'Error',
  };
  return map[phase] || phase;
}

function escapeHtmlClient(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// On page load, mark the original chunk-param values so we can detect changes.
document.addEventListener('DOMContentLoaded', () => {
  initEmbeddingsTab();
});

/**
 * Per-tab init. Called from main DOMContentLoaded AND from an inline
 * script at the end of the embeddings tab fragment so it runs after
 * HTMX swaps the tab in.
 */
function initEmbeddingsTab() {
  const root = document.querySelector('[data-embedding-settings]');
  if (!root) return; // tab not loaded yet
  document.querySelectorAll('[data-chunk-param]').forEach((el) => {
    el.dataset.original = el.value;
  });
  refreshDownloadUi();
  updateSaveButtonLabel();
  // Seed the recommended hint with the active model's value.
  try {
    const sel = document.getElementById('embedding-preset');
    if (sel && sel.value && sel.value !== '__custom__') {
      onEmbeddingPresetChange(sel.value);
    }
  } catch (err) {
    console.warn('init hint failed', err);
  }
}
globalThis.initEmbeddingsTab = initEmbeddingsTab;
