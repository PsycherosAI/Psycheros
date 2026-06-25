/**
 * Voice Chat Client (walkie-talkie mode)
 *
 * Two STT modes:
 *   - "browser": use the Web Speech API (SpeechRecognition) for STT. The
 *     browser transcribes; we send text to the daemon. Mic is still captured
 *     for the waveform visualizer but no audio frames are sent.
 *   - server-side (deepgram/openai/custom): send PCM frames to the daemon
 *     and let it transcribe.
 *
 * Two input modes:
 *   - Default (end-of-speech detection): browser-side energy VAD detects
 *     silence and tells the daemon to process the turn.
 *   - PTT (push-to-talk): user holds a button to record, releases to send.
 *
 * State messages from the daemon drive the UI label:
 *   idle → recording → processing → speaking → idle
 */

// =============================================================================
// State
// =============================================================================

let voiceWs = null;
let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let analyserNode = null;
let gainNode = null;
let processorNode = null;
let playbackGain = null;
// Walkie-talkie state from the daemon. Drives the end-of-turn audio cue
// and the waveform active/muted visual.
let currentWalkieState = "idle";
let previousWalkieState = null;
let isMuted = false;
let isDeafened = false;
let activeConversationId = null;
let wakeLock = null;
// Silent audio loop element. Kept playing during voice calls (and during
// keybind capture) for two reasons:
//   1. Bluetooth media button routing — Android only sends media key events
//      to the app that currently OWNS the media session. Without active
//      audio, the page doesn't own the session and Shokz/headset buttons
//      never arrive. The silent loop claims the session.
//   2. Screen wake lock fallback — Android's auto-screen-off is more
//      aggressive for apps with no audio activity. The Wake Lock API is
//      primary, but the silent loop is a reliable fallback.
// Uses a short base64-encoded silent WAV (about 0.01s of silence, ~80
// bytes) looped at low-but-nonzero volume.
let silentAudioEl = null;

// Walkie-talkie state
let sttProvider = "browser";
let pttEnabled = false;
let pttKeys = ["Space"];
let pttHolding = false;
let endOfTurnSilence = 1.5;
let phraseDebounceMs = 1200;
let sttDebug = false;
let voiceChatDebug = false;
let sttLanguage = "";
let voiceEffect = "none";
let voiceEffectNodes = null; // { input, output } for the effect chain
let recognition = null; // SpeechRecognition instance (browser STT)
let silenceTimer = null; // setTimeout handle for end-of-speech detection
let silenceLevel = new Uint8Array(0); // last analyser reading
let isRecording = false; // tracks whether we're accumulating audio

// Voice chat debug helper. No-op unless voiceChatDebug is on (set from
// the active voice profile via #voice-status-cfg). Routes to the
// "Voice chat debug log" panel in Audio settings when present, falls
// back to console only otherwise. Categories: mic-perm, ws, state,
// audio, tts, stt, debug.
function voiceDebug(category, message) {
  if (!voiceChatDebug) return;
  if (globalThis.appendVoiceDebug) {
    globalThis.appendVoiceDebug(category, message);
  } else {
    console.log(`[voice:${category}] ${message}`);
  }
}

const PCM_FRAME_SIZE = 640; // 20ms of 16kHz mono Int16
const SAMPLE_RATE = 16000;
const RESAMPLE_RATIO = 48000 / SAMPLE_RATE;
const SILENCE_THRESHOLD = 0.02; // RMS below this counts as silence
const VAD_CHECK_INTERVAL_MS = 100;

// =============================================================================
// Lifecycle
// =============================================================================

/**
 * Open the voice call overlay for a conversation.
 */
async function openVoiceChat(conversationId) {
  if (activeConversationId) {
    showToast('A voice call is already active');
    return;
  }

  activeConversationId = conversationId;

  // Load the voice call overlay fragment FIRST so we can read the embedded
  // sttProvider before deciding whether to acquire the mic.
  let loadedHtml = null;
  try {
    const resp = await fetch(`/fragments/voice-call/${conversationId}`);
    if (!resp.ok) {
      showToast('Failed to load voice call');
      cleanup();
      return;
    }
    loadedHtml = await resp.text();
  } catch (err) {
    showToast('Failed to load voice call');
    cleanup();
    return;
  }

  // Peek at the embedded config to learn the STT provider before mic
  // acquisition. Wrapped in a try/catch — defaults to 'browser' on error.
  // Also peek at voiceChatDebug so the diagnostic logs below can be gated
  // without waiting for the full config parse.
  let earlySttProvider = 'browser';
  let earlyVoiceChatDebug = false;
  try {
    const temp = document.createElement('div');
    temp.innerHTML = loadedHtml;
    const cfgEl = temp.querySelector('#voice-status-cfg');
    if (cfgEl) {
      const c = JSON.parse(cfgEl.textContent);
      earlySttProvider = c.sttProvider ?? 'browser';
      earlyVoiceChatDebug = !!c.voiceChatDebug;
    }
  } catch {}

  // Fallback if the HTML config peek failed.
  if (earlySttProvider === 'browser') {
    try {
      const resp = await fetch('/api/voice/status', { headers: { 'Accept': 'application/json' } });
      if (resp.ok) {
        const s = await resp.json();
        if (s.sttProvider && s.sttProvider !== 'browser') {
          try {
            await fetch('/api/voice/log', { method: 'POST', body: `config peek failed — recovered STT=${s.sttProvider}` });
          } catch {}
          earlySttProvider = s.sttProvider;
        }
      }
    } catch {}
  }

  try {
    await fetch('/api/voice/log', {
      method: 'POST',
      body: JSON.stringify({ event: 'openVoiceChat', stt: earlySttProvider, tauri: !!window.__TAURI__?.core?.invoke, channel: !!window.__TAURI__?.core?.Channel, debug: earlyVoiceChatDebug }),
    });
  } catch {}

  // Acquire the mic only when the stream is actually needed.
  //
  // We need getUserMedia for two things: the waveform visualizer (always,
  // when we have a stream) and server-side STT audio capture (only when
  // sttProvider !== 'browser').
  //
  // BUT — on Chrome Android, an active getUserMedia stream holding the
  // mic prevents SpeechRecognition from accessing it. They fight over
  // the mic and SpeechRecognition loses silently: it starts without
  // error but never fires onspeechstart or onresult. So in browser STT
  // mode we skip getUserMedia entirely and the waveform stays empty.
  // Status text + STT event toasts carry the visual feedback instead.
  if (earlySttProvider !== 'browser') {
    const tauriInvoke = window.__TAURI__?.core?.invoke;
    const TauriChannel = window.__TAURI__?.core?.Channel;
    if (tauriInvoke && TauriChannel) {
      if (earlyVoiceChatDebug && globalThis.appendVoiceDebug) {
        globalThis.appendVoiceDebug('mic-perm', `Tauri detected — using native mic-capture plugin (STT provider: ${earlySttProvider})`);
      }
      const channel = new TauriChannel('audio-frame');
      let nativeFrameCount = 0;
      let nativeDroppedCount = 0;
      channel.onmessage = (message) => {
        nativeFrameCount++;
        if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN) {
          nativeDroppedCount++;
          if (earlyVoiceChatDebug && globalThis.appendVoiceDebug && (nativeDroppedCount <= 3 || nativeDroppedCount % 50 === 0)) {
            globalThis.appendVoiceDebug('tts', `frame dropped (ws not open) — dropped ${nativeDroppedCount}/${nativeFrameCount}`);
          }
          return;
        }
        voiceWs.send(new Uint8Array(message).buffer);

        // RMS for JS-side VAD (no analyserNode in native capture path).
        if (Array.isArray(message)) {
          let sumSq = 0;
          const sampleCount = message.length >> 1;
          for (let j = 0; j < message.length - 1; j += 2) {
            let val = message[j] | (message[j + 1] << 8);
            if (val > 32767) val -= 65536;
            const n = val / 32768;
            sumSq += n * n;
          }
          nativeRms = Math.sqrt(sumSq / Math.max(sampleCount, 1));
          nativePeakRms = Math.max(nativePeakRms, nativeRms);
        }

        if (earlyVoiceChatDebug && globalThis.appendVoiceDebug) {
          if (nativeFrameCount === 1) {
            const bytes = Array.isArray(message) ? message.length : 0;
            globalThis.appendVoiceDebug('tts', `first frame sent to WS: ${bytes} bytes`);
          } else if (nativeFrameCount % 50 === 0) {
            globalThis.appendVoiceDebug('tts', `${nativeFrameCount} frames sent to WS (${nativeDroppedCount} dropped)`);
          }
        }
      };
      try {
        await tauriInvoke('plugin:psycheros-mic-capture|start_capture', { onFrame: channel });
        nativeCaptureActive = true;
        voiceDebug('capture', 'native capture started — frames flowing to channel');
        try {
          await fetch('/api/voice/log', { method: 'POST', body: 'native capture started OK' });
        } catch {}
        if (earlyVoiceChatDebug && globalThis.appendVoiceDebug) {
          globalThis.appendVoiceDebug('mic-perm', 'native capture started');
        }
      } catch (err) {
        const detail = err && err.message ? err.message : String(err);
        showToast(`Mic capture failed: ${detail}`, 'warning');
        try {
          await fetch('/api/voice/log', {
            method: 'POST',
            body: `native capture FAILED: ${detail}`,
          });
        } catch {}
        if (earlyVoiceChatDebug && globalThis.appendVoiceDebug) {
          globalThis.appendVoiceDebug('mic-perm', `start_capture FAILED: ${detail}`);
        }
        cleanup();
        return;
      }
    } else {
      if (earlyVoiceChatDebug && globalThis.appendVoiceDebug) {
        globalThis.appendVoiceDebug(
          'mic-perm',
          `No Tauri native capture (${tauriInvoke ? 'invoke present, ' : 'no invoke, '}${TauriChannel ? 'Channel present' : 'no Channel'}) — falling through to getUserMedia`,
        );
      }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
      });
    } catch (err) {
      // Detect the most common cause first: insecure origin. Browsers
      // silently refuse getUserMedia on http://<lan-ip>:port with no
      // prompt — the user never sees a dialog and "allow mic in settings"
      // doesn't help because the page itself isn't allowed to ask.
      // Has to be HTTPS, localhost, or a secure context (Tauri).
      if (!window.isSecureContext) {
        showToast(
          'Mic needs a secure origin. Open Psycheros at http://localhost:3000 or https://... — LAN IPs over plain HTTP cannot access the mic.',
          'warning',
        );
      } else if (err && err.name === 'NotAllowedError') {
        showToast(
          'Microphone permission denied. Allow it in your browser site settings for this origin.',
          'warning',
        );
      } else if (err && err.name === 'NotFoundError') {
        showToast('No microphone found. Connect one and try again.', 'warning');
      } else {
        const detail = err && err.message ? err.message : 'access denied';
        showToast(`Microphone error: ${detail}`, 'warning');
      }
      cleanup();
      return;
    }
    }
  }

  // Mount the overlay fragment we already loaded.
  const chatEl = document.getElementById('chat');
  if (chatEl) {
    const container = document.createElement('div');
    container.innerHTML = loadedHtml;
    document.body.appendChild(container.firstElementChild);
  }

  // Read config embedded by the server
  const cfg = document.getElementById('voice-status-cfg');
  if (cfg) {
    try {
      const parsed = JSON.parse(cfg.textContent);
      sttProvider = parsed.sttProvider ?? "browser";
      pttEnabled = !!parsed.pttEnabled;
      pttKeys = Array.isArray(parsed.pttKeys) ? parsed.pttKeys : ["Space"];
      endOfTurnSilence = parsed.endOfTurnSilence ?? 1.5;
      phraseDebounceMs = parsed.phraseDebounceMs ?? 1200;
      sttDebug = !!parsed.sttDebug;
      voiceChatDebug = !!parsed.voiceChatDebug;
      sttLanguage = parsed.sttLanguage ?? "";
      voiceEffect = parsed.voiceEffect ?? "none";
    } catch {}
  }

  // Show voice banner in chat
  showVoiceBanner(true);

  // Connect WS before mic capture so frames aren't dropped while WS opens.
  connectVoiceWs(conversationId);

  // Start audio pipeline (capture for server-side STT, analyser for VAD/waveform)
  setupAudioCapture();

  // Start silence detector for non-PTT server-side STT modes
  if (!pttEnabled && sttProvider !== "browser") {
    startSilenceDetector();
  }

  // Set up browser-native STT if applicable. Always create the recognition
  // object so PTT can drive it on demand (startPTT/endPTT call
  // recognition.start()/stop()). Only auto-start continuous listening when
  // NOT in PTT mode — in PTT mode, the user holds the button to talk.
  if (sttProvider === "browser") {
    startBrowserSTT({ autoStart: !pttEnabled });
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', voiceKeyHandler);
  document.addEventListener('keyup', voiceKeyHandler);
  // Mouse button PTT (for bindings like Mouse3/Mouse4)
  document.addEventListener('mousedown', voiceMouseHandler);
  document.addEventListener('mouseup', voiceMouseHandler);

  // Show hold circle + active toggle if PTT is enabled from settings
  if (pttEnabled) {
    const toggleBtn = document.getElementById('voice-btn-ptt-toggle');
    const holdCircle = document.getElementById('voice-hold-circle');
    if (toggleBtn) toggleBtn.classList.add('voice-btn--active');
    if (holdCircle) holdCircle.style.display = 'flex';
  }

  // Activate MediaSession so Bluetooth headset buttons (Shokz, AirPods, etc.)
  // route to the page. Any MediaSession-type PTT bindings get toggle handlers
  // that flip PTT on/off. Keyboard/mouse bindings use hold (keydown/keyup).
  setupMediaSessionPTT();

  // Request a screen wake lock so the screen stays on during the call.
  // Without this, Android auto-turns-off the screen after the timeout and
  // kills the WebSocket + mic access. The user can still manually turn off
  // the screen (which will kill the call) but at least auto-timeout is
  // prevented.
  requestWakeLock();
  // Start the silent audio loop. Claims the OS media session so Bluetooth
  // headset buttons (Shokz etc.) route to the page, and acts as a wake
  // lock fallback if navigator.wakeLock fails or is overridden by Android
  // battery saver.
  startSilentAudio();
}

/**
 * Request a screen wake lock to prevent the screen from auto-turning-off
 * during a voice call. Non-fatal if unsupported (older browsers, Firefox
 * without flag, etc.) — the call still works, just the screen may time out.
 *
 * Wake locks are automatically released when the page becomes invisible
 * (user switches tabs, minimizes). We re-acquire on visibilitychange.
 */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    document.addEventListener('visibilitychange', handleVisibilityChange);
  } catch (err) {
    // Not fatal — the call continues, screen just may time out
    console.debug('[Voice] Wake lock request failed:', err);
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && activeConversationId && !wakeLock) {
    requestWakeLock();
  }
}

function releaseWakeLock() {
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  if (wakeLock) {
    try { wakeLock.release(); } catch {}
    wakeLock = null;
  }
}

/** Mobile-only — silent audio is for Android MediaSession claiming + screen-off fallback. */
function isMobileBrowser() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

/**
 * Mobile-only. Claims the OS media session for Bluetooth headset button
 * routing and acts as a screen-off fallback. Disabled on desktop — an
 * empty WAV data URL previously spun Chrome's audio thread (browser-wide
 * freeze), and desktop doesn't need it anyway (Wake Lock + media keys
 * work without claiming the session).
 *
 * Generates a real 1-second silent WAV via Web Audio rather than a base64
 * blob so each loop iteration has real work.
 */
function startSilentAudio() {
  if (silentAudioEl) return;
  if (!isMobileBrowser()) return;
  try {
    const sampleRate = 8000;
    const numSamples = sampleRate; // 1 second
    const buffer = new ArrayBuffer(44 + numSamples);
    const view = new DataView(buffer);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + numSamples, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true); // 8-bit
    writeAscii(view, 36, 'data');
    view.setUint32(40, numSamples, true);
    // 0x80 = silence in unsigned 8-bit PCM
    for (let i = 0; i < numSamples; i++) view.setUint8(44 + i, 0x80);
    const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    const el = new Audio(url);
    el.loop = true;
    el.volume = 0.001;
    el.preload = 'auto';
    el.addEventListener('canplaythrough', () => {
      try { URL.revokeObjectURL(url); } catch {}
    }, { once: true });
    const tryPlay = () => {
      el.play().catch((err) => console.debug('[Voice] Silent audio play() failed:', err));
    };
    if (el.readyState >= 2) tryPlay();
    else el.addEventListener('canplaythrough', tryPlay, { once: true });
    silentAudioEl = el;
  } catch (err) {
    console.debug('[Voice] Failed to generate silent audio:', err);
  }
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function stopSilentAudio() {
  if (!silentAudioEl) return;
  try {
    silentAudioEl.pause();
    silentAudioEl.src = '';
    silentAudioEl.load();
  } catch {}
  silentAudioEl = null;
}

/**
 * End the active voice call.
 */
function endVoiceChat() {
  if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
    voiceWs.send(JSON.stringify({ type: 'end_call' }));
  }
  cleanup();
  showToast('Voice call ended');
}

function cleanup() {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  if (recognition) {
    try { recognition.stop(); } catch {}
    recognition = null;
  }

  if (voiceWs) {
    try { voiceWs.close(); } catch {}
    voiceWs = null;
  }

  if (processorNode) {
    try { processorNode.disconnect(); } catch {}
    processorNode = null;
  }
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch {}
    sourceNode = null;
  }
  if (analyserNode) {
    try { analyserNode.disconnect(); } catch {}
    analyserNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    try { audioContext.close(); } catch {}
    audioContext = null;
  }
  playbackGain = null;
  voiceEffectNodes = null;
  playbackBuffer = [];
  playbackPlaying = false;
  pendingYourTurnCue = false;
  pendingBytes = null;
  sawFirstTtsFrame = false;
  ttsFrameCount = 0;

  const transcriptEl = document.getElementById('voice-transcript');
  if (transcriptEl) transcriptEl.innerHTML = '';

  // Stop the Tauri native mic-capture plugin if it was running. Fire
  // and forget — we don't need to wait, and the next call will refuse
  // to start if a previous one is somehow still active.
  if (nativeCaptureActive && window.__TAURI__?.core?.invoke) {
    nativeCaptureActive = false;
    window.__TAURI__.core.invoke('plugin:psycheros-mic-capture|stop_capture').catch((err) => {
      console.warn('[voice] stop_capture failed:', err);
    });
  }

  // Reset toast element references — the overlay (and everything inside
  // it) gets removed below, so these references would be stale.
  pulseToastEl = null;
  toolToastEl = null;
  toolChips.clear();

  const overlay = document.getElementById('voice-overlay');
  if (overlay) overlay.remove();

  showVoiceBanner(false);

  document.removeEventListener('keydown', voiceKeyHandler);
  document.removeEventListener('keyup', voiceKeyHandler);
  document.removeEventListener('mousedown', voiceMouseHandler);
  document.removeEventListener('mouseup', voiceMouseHandler);

  // Refresh the conversation so the voice transcript messages (persisted
  // during the call as [Voice Chat] entries) show up in the chat UI.
  // Otherwise the user has to manually reload to see what was said.
  // Captured before clearing activeConversationId below.
  const conversationToRefresh = activeConversationId;
  if (conversationToRefresh && globalThis.Psycheros?.selectConversation) {
    try {
      globalThis.Psycheros.selectConversation(conversationToRefresh);
    } catch (err) {
      console.warn('[Voice] Failed to refresh conversation after call:', err);
    }
  }

  isMuted = false;
  isDeafened = false;
  isRecording = false;
  yinYangMode = false;
  pttHolding = false;
  sttStartCount = 0;
  sttSpeechStartCount = 0;
  sttResultCount = 0;
  if (sttPhraseDebounceTimer) {
    clearTimeout(sttPhraseDebounceTimer);
    sttPhraseDebounceTimer = null;
  }
  if (endPTTFlushTimer) {
    clearTimeout(endPTTFlushTimer);
    endPTTFlushTimer = null;
  }
  pendingEndPTTFlush = false;
  sttPhraseBuffer = [];
  teardownMediaSessionPTT();
  releaseWakeLock();
  stopSilentAudio();
  currentWalkieState = "idle";
  previousWalkieState = null;
  activeConversationId = null;
}

// =============================================================================
// Audio Capture
// =============================================================================

function setupAudioCapture() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 48000,
  });
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  voiceDebug('audio', `AudioContext created: state=${audioContext.state} sampleRate=${audioContext.sampleRate} (requested 48000)`);
  voiceDebug('audio', `mic stream: ${mediaStream ? 'present' : 'null'} — sttProvider=${sttProvider} voiceEffect=${voiceEffect}`);

  // Source + analyser + processor are only set up when we have a mic
  // stream. In browser STT mode we skip getUserMedia entirely (see
  // openVoiceChat) to avoid conflicting with SpeechRecognition on Chrome
  // Android, so mediaStream is null here. The waveform canvas will be
  // blank in that mode — the trade-off for actually working STT.
  if (mediaStream) {
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    sourceNode.connect(analyserNode);

    // ScriptProcessor is deprecated but widely supported for raw PCM access.
    // Only wire it up for server-side STT modes — browser STT uses
    // SpeechRecognition instead.
    if (sttProvider !== "browser") {
      processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);
      processorNode.onaudioprocess = onAudioProcess;
    }
  }

  // Build voice effect chain for TTS playback. Inserts between playbackGain
  // and destination. All presets use cheap Web Audio nodes (1-3 nodes each).
  if (voiceEffect !== 'none') {
    voiceEffectNodes = buildVoiceEffectChain(audioContext, voiceEffect);
  }

  // Create playbackGain upfront so all audio (TTS playback AND cue tones)
  // routes through the same gain node. Connect through the effect chain
  // if one was built, otherwise straight to destination.
  playbackGain = audioContext.createGain();
  playbackGain.gain.value = 1.0;
  if (voiceEffectNodes) {
    playbackGain.connect(voiceEffectNodes.input);
    voiceEffectNodes.output.connect(audioContext.destination);
  } else {
    playbackGain.connect(audioContext.destination);
  }
}

/**
 * Build a Web Audio effect chain for TTS playback. Returns { input, output }
 * that get inserted between playbackGain and ctx.destination.
 *
 * All presets are designed to "embrace the synthetic" — they add character
 * rather than trying to hide it. CPU overhead is negligible (1-3 cheap
 * filter/delay nodes per preset).
 */
function buildVoiceEffectChain(ctx, effect) {
  const input = ctx.createGain();
  const output = ctx.createGain();

  if (effect === 'comms') {
    // Highpass at 120Hz + 150ms delay at 30% wet — classic sci-fi intercom
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 120;
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.09;
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    input.connect(hp);
    hp.connect(output); // dry
    hp.connect(delay);
    delay.connect(wet);
    wet.connect(output);
  } else if (effect === 'robot') {
    // Ring modulation at 50Hz — metallic Dalek/Cylon voice
    const osc = ctx.createOscillator();
    osc.frequency.value = 50;
    osc.type = 'sine';
    const ringMod = ctx.createGain();
    ringMod.gain.value = 0; // base 0, oscillator adds ±1
    osc.connect(ringMod.gain);
    input.connect(ringMod);
    ringMod.connect(output);
    osc.start();
  } else if (effect === 'telephone') {
    // Bandpass at 1500Hz — retro lo-fi phone call
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 1;
    input.connect(bp);
    bp.connect(output);
  } else if (effect === 'deep') {
    // Lowpass at 2kHz + bass boost at 100Hz — commanding, authoritarian
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2000;
    const bass = ctx.createBiquadFilter();
    bass.type = 'peaking';
    bass.frequency.value = 100;
    bass.gain.value = 6;
    bass.Q.value = 1;
    input.connect(lp);
    lp.connect(bass);
    bass.connect(output);
  } else if (effect === 'cavern') {
    // Feedback delay with lowpass — vast, distant space, station transmission
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.05;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.4;
    const fbLowpass = ctx.createBiquadFilter();
    fbLowpass.type = 'lowpass';
    fbLowpass.frequency.value = 1500;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    input.connect(output); // dry
    input.connect(delay);
    delay.connect(wet);
    wet.connect(output);
    // Feedback loop: delay → feedback → lowpass → back to delay
    delay.connect(feedback);
    feedback.connect(fbLowpass);
    fbLowpass.connect(delay);
  } else {
    input.connect(output);
  }

  return { input, output };
}

function onAudioProcess(e) {
  if (isMuted || yinYangMode || !voiceWs || voiceWs.readyState !== WebSocket.OPEN) return;

  const inputData = e.inputBuffer.getChannelData(0);
  const resampled = resample48000to16k(inputData);
  const pcm16 = float32ToInt16(resampled);

  for (let offset = 0; offset < pcm16.byteLength; offset += PCM_FRAME_SIZE) {
    const end = Math.min(offset + PCM_FRAME_SIZE, pcm16.byteLength);
    const frame = pcm16.slice(offset, end);
    if (frame.byteLength === PCM_FRAME_SIZE) {
      voiceWs.send(frame);
    }
  }
}

/**
 * Resample from 48kHz to 16kHz (3:1 decimation).
 */
function resample48000to16k(input) {
  const outputLength = Math.floor(input.length / RESAMPLE_RATIO);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * RESAMPLE_RATIO;
    output[i] = input[Math.floor(srcIdx)];
  }
  return output;
}

function float32ToInt16(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16.buffer;
}

// =============================================================================
// Browser-Native STT (Web Speech API)
// =============================================================================

let sttStartCount = 0;
// Diagnostics: track whether SpeechRecognition is actually hearing us.
// If sttSpeechStartCount stays 0, Chrome never detected speech. If
// sttResultCount stays 0, Chrome detected speech but produced no
// transcripts. Either way, the user has no path to send voice messages.
let sttSpeechStartCount = 0;
let sttResultCount = 0;

// Phrase accumulation buffer for browser STT. Chrome Android fires a
// "final" result at every natural phrase pause, so "Hey, can you help
// me with something?" arrives as 3-5 separate finals. We collect them
// here and flush as a single transcript after `phraseDebounceMs` of
// silence — gives the entity the full utterance instead of fragmenting
// it into multiple turns. `phraseDebounceMs` comes from the voice
// profile's Audio settings (default 1200ms).
let sttPhraseBuffer = [];
let sttPhraseDebounceTimer = null;
// True between endPTT() and the next recognition.onend (or the fallback
// timeout). Signals onend to flush the phrase buffer — Chrome emits any
// pending final results BEFORE onend, so flushing there captures the
// last phrase instead of splitting it into a separate transcript.
let pendingEndPTTFlush = false;
let endPTTFlushTimer = null;

function flushSttPhraseBuffer() {
  sttPhraseDebounceTimer = null;
  if (sttDebug) console.log('[Voice:stt] flushSttPhraseBuffer — pttHolding=' + pttHolding + ' phrases=' + sttPhraseBuffer.length);
  // Don't flush mid-PTT-hold — the user controls when their utterance
  // ends via button release. endPTT() calls this explicitly after
  // recognition.stop(), so the buffer flushes on release. Without this
  // guard, a pause longer than phraseDebounceMs mid-hold would push a
  // partial transcript to the daemon and trigger processing before the
  // user has released PTT.
  if (pttHolding) return;
  if (sttPhraseBuffer.length === 0) return;
  const combined = sttPhraseBuffer.join(' ').trim();
  sttPhraseBuffer = [];
  if (!combined) return;
  // Diagnostic: show what's being sent. Gated on sttDebug.
  if (sttDebug) {
    showVoiceToast('Heard: ' + combined.slice(0, 80));
  }
  if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
    voiceWs.send(JSON.stringify({ type: 'transcript', text: combined }));
  }
}

/**
 * Set up browser-native STT. Creates the SpeechRecognition object and
 * optionally starts it. In PTT mode we want the recognition object to
 * exist (so startPTT/endPTT can drive it) but not auto-start — otherwise
 * continuous listening would fire transcripts regardless of hold state.
 */
function startBrowserSTT(opts) {
  const autoStart = opts ? opts.autoStart !== false : true;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showVoiceToast("Browser-native STT not available — switch to a server-side provider in voice settings");
    return;
  }
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  // interimResults=true keeps Chrome's recognizer engaged while the user
  // speaks — Chrome Android is more aggressive about ending recognition
  // early when interimResults=false, which produces spurious onend events
  // and prevents transcripts from ever finalizing. We still only send
  // finalized results (see the isFinal filter in onresult).
  recognition.interimResults = true;
  if (sttLanguage) recognition.lang = sttLanguage;

  recognition.onresult = (event) => {
    // Walk through new results since the last turn
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript.trim();
      // Diagnostic: surface the first interim result so we know Chrome is
      // actually hearing us. If this never appears, Chrome's recognizer
      // isn't producing transcripts at all (mic routing, language pack,
      // service issue, etc).
      if (!result.isFinal) {
        if (sttDebug && sttResultCount === 0 && transcript) {
          showVoiceToast('Heard (interim): ' + transcript.slice(0, 40));
        }
        continue;
      }
      sttResultCount++;
      if (!transcript) continue;
      // Two possible "final" patterns from SpeechRecognition:
      //
      // 1. Disjoint phrases (spec'd behavior): each final is a new phrase.
      //    Accumulate them — "Hey" + "can you help" + "with something?" →
      //    joined into one utterance.
      //
      // 2. Cumulative snapshots (observed on Chrome Android): each final
      //    contains the full session transcript so far. "okay" → "okay
      //    I'm" → "okay I'm trying". If we append every snapshot we get
      //    "okay okay I'm okay I'm trying okay I'm trying..." snowballs.
      //    Detect by checking if the new transcript starts with (or
      //    contains) the joined buffer — if so, REPLACE the buffer with
      //    the latest snapshot instead of appending.
      //
      // Comparison must be case-insensitive and punctuation-insensitive
      // because Chrome's recognizer changes its mind about capitalization
      // and punctuation between finals ("yeah" → "Yeah" → "Yeah, but").
      // A naive case-sensitive startsWith misses the overlap and lets the
      // snowball grow.
      const norm = (s) => s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
      const currentJoined = sttPhraseBuffer.join(' ').trim();
      const normBuf = norm(currentJoined);
      const normNew = norm(transcript);
      const isCumulative = normBuf && (
        normNew.startsWith(normBuf) ||
        normBuf.startsWith(normNew)
      );
      if (sttDebug) console.log('[Voice:stt] final result — pttHolding=' + pttHolding + ' cumulative=' + isCumulative + ' text="' + transcript.slice(0, 80) + '"');
      if (isCumulative) {
        // Take the longer one — usually the new transcript, but if the
        // recognizer revised downward (rare) keep what we had.
        if (normNew.length >= normBuf.length) {
          sttPhraseBuffer = [transcript];
        }
      } else {
        sttPhraseBuffer.push(transcript);
      }
      if (sttPhraseDebounceTimer) {
        clearTimeout(sttPhraseDebounceTimer);
      }
      sttPhraseDebounceTimer = setTimeout(flushSttPhraseBuffer, phraseDebounceMs);
    }
  };

  recognition.onerror = (event) => {
    // `no-speech` fires whenever the recognizer goes quiet without detecting
    // speech (between turns, during silence). It's a normal event, not a bug.
    // `aborted` fires when we intentionally stop recognition (mute toggle,
    // session end). Only log genuinely unexpected errors.
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.error('[Voice:stt] SpeechRecognition error:', event.error);
      // Surface as a toast so the user (and we) can see what's happening on
      // devices where the dev console isn't easily accessible.
      showVoiceToast('STT error: ' + event.error);
    }
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      showVoiceToast("Microphone permission denied for STT");
    }
  };

  // Tell the server the moment the user starts speaking. The server uses
  // this to defer Pulse draining — without it, a Pulse that fires right
  // after the entity finishes responding would interrupt the user
  // mid-utterance (their transcript would arrive during the Pulse response
  // and get dropped by the interruption guard).
  recognition.onspeechstart = () => {
    // Diagnostic: confirm Chrome detected speech. Gated on sttDebug.
    if (sttDebug && sttSpeechStartCount === 0) {
      showVoiceToast('Speech detected');
    }
    sttSpeechStartCount++;
    if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
      voiceWs.send(JSON.stringify({ type: 'user_speech_start' }));
    }
  };

  // Auto-restart on end so the user can take multiple turns without
  // re-clicking anything. In PTT mode, recognition is started/stopped
  // explicitly by startPTT/endPTT — don't auto-restart here or PTT
  // release has no effect. Also skip in Yin Yang mode — the user has
  // explicitly paused voice input to type instead.
  //
  // A short delay before restart is important on Chrome Android: the
  // OS plays a "no longer listening" system tone when recognition ends
  // and a "listening" tone when it starts again. Without a delay, the
  // two tones overlap into a mess. The delay also gives Chrome's
  // speech service a moment to fully release the previous session,
  // which makes the next start() more reliable.
  recognition.onend = () => {
    if (sttDebug) console.log('[Voice:stt] onend fired — pttEnabled=' + pttEnabled + ' pttHolding=' + pttHolding + ' pendingEndPTTFlush=' + pendingEndPTTFlush);
    // If endPTT() was called, this onend is the signal that Chrome has
    // finished emitting pending finals. Flush now — at this point the
    // buffer contains every phrase including the trailing one that
    // arrives between stop() and onend.
    if (pendingEndPTTFlush) {
      pendingEndPTTFlush = false;
      if (endPTTFlushTimer) {
        clearTimeout(endPTTFlushTimer);
        endPTTFlushTimer = null;
      }
      if (sttDebug) console.log('[Voice:stt] endPTT flush — onend fired, flushing ' + sttPhraseBuffer.length + ' phrase(s)');
      flushSttPhraseBuffer();
      return;
    }
    if (pttEnabled) {
      // Chrome's SpeechRecognition has its own internal VAD that fires
      // onend after a silence. In PTT mode, if the user is still holding
      // the button, restart recognition so speech after a pause is still
      // captured. Without this, recognition stays dead until the user
      // releases and re-presses PTT.
      //
      // pttHolding flips to false in endPTT() BEFORE recognition.stop()
      // runs, so an intentional button release does NOT trigger a restart
      // here. The 300ms delay is for Chrome Android only — its OS plays
      // overlapping stop/start tones without it, and the speech service
      // needs a moment to release the previous session. Desktop Chrome
      // doesn't need the delay; restart immediately so we don't miss the
      // first syllable after a pause.
      if (pttHolding && !isMuted && !yinYangMode) {
        const restartDelay = isMobileBrowser() ? 300 : 0;
        setTimeout(() => {
          if (pttHolding && !isMuted && !yinYangMode && recognition) {
            try {
              recognition.start();
              if (sttDebug) console.log('[Voice:stt] restart succeeded');
            } catch (err) {
              console.warn('[Voice:stt] restart failed:', err && err.message ? err.message : err);
            }
          }
        }, restartDelay);
      }
      return;
    }
    if (yinYangMode) return;
    if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN || isMuted) return;
    setTimeout(() => {
      if (pttEnabled || yinYangMode) return;
      if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN || isMuted) return;
      try { recognition.start(); } catch {}
    }, 300);
  };

  if (!autoStart) return;
  try {
    recognition.start();
    // Diagnostic: confirm STT actually started. Gated on sttDebug. Only
    // shows on the first start (not on auto-restarts from onend), which
    // would otherwise spam the toast every few seconds.
    if (sttDebug && sttStartCount === 0) {
      showVoiceToast('STT listening');
    }
    sttStartCount++;
  } catch (err) {
    console.error('[Voice:stt] Failed to start SpeechRecognition:', err);
    showVoiceToast('STT failed to start: ' + (err && err.message ? err.message : err));
  }
}

// =============================================================================
// Silence Detection (VAD for default end-of-speech mode)
// =============================================================================

function startSilenceDetector() {
  const check = () => {
    if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN) return;

    // PTT mode: the user controls turn end via button release. Skip VAD
    // logic entirely so a mid-call toggle into PTT mode doesn't keep
    // firing user_silence.
    if (pttEnabled) {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      isRecording = false;
      setTimeout(check, VAD_CHECK_INTERVAL_MS);
      return;
    }

    let rms;
    if (nativeCaptureActive) {
      rms = nativePeakRms;
      nativePeakRms = 0;
    } else {
      if (!analyserNode) return;
      const bufferLength = analyserNode.frequencyBinCount;
      if (silenceLevel.length !== bufferLength) {
        silenceLevel = new Uint8Array(bufferLength);
      }
      analyserNode.getByteTimeDomainData(silenceLevel);
      let sumSq = 0;
      for (let i = 0; i < silenceLevel.length; i++) {
        const v = (silenceLevel[i] - 128) / 128;
        sumSq += v * v;
      }
      rms = Math.sqrt(sumSq / silenceLevel.length);
    }

    if (rms > SILENCE_THRESHOLD) {
      // Voice activity — recording in progress
      if (!isRecording) {
        isRecording = true;
      }
      // Cancel any pending silence timer
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
    } else if (isRecording && !silenceTimer && !isMuted) {
      // Silence after speech — start the turn-end timer
      silenceTimer = setTimeout(() => {
        // Defensive: if PTT was toggled on while we were waiting, bail.
        // The user now controls turn end via button release. (check()
        // also bails on pttEnabled, but the timer may already be pending
        // from a previous iteration.)
        if (pttEnabled) {
          silenceTimer = null;
          return;
        }
        if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
          voiceWs.send(JSON.stringify({ type: 'user_silence' }));
        }
        isRecording = false;
        silenceTimer = null;
      }, endOfTurnSilence * 1000);
    }

    setTimeout(check, VAD_CHECK_INTERVAL_MS);
  };
  setTimeout(check, VAD_CHECK_INTERVAL_MS);
}

// =============================================================================
// Push-to-Talk
// =============================================================================

/**
 * Activate MediaSession and set action handlers for any MediaSession-type PTT
 * bindings (Bluetooth headset buttons). These use toggle semantics: press once
 * to start recording, press again to send. Keyboard/mouse bindings use hold
 * semantics (keydown/keyup) via the separate voiceKeyHandler.
 *
 * Called from openVoiceChat. Cleaned up in cleanup().
 */
function setupMediaSessionPTT() {
  if (!('mediaSession' in navigator)) return;
  // Claim the media session so the OS routes headset button events to us
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'Voice Chat',
    artist: 'Psycheros',
  });
  // If the user registered ANY MediaSession binding, bind ALL standard
  // media actions to the same toggle handler. Headsets vary in which
  // action they send — Shokz OpenRun Pro sends `pause` on single press
  // but other headsets send `play` or `playpause`. If we only bind the
  // exact action the user registered, we miss the press when the
  // headset sends a different action name.
  var hasMsBinding = pttKeys.some(function (k) {
    return k.indexOf('MediaSession:') === 0;
  });
  if (!hasMsBinding) return;
  var allActions = ['play', 'pause', 'previoustrack', 'nexttrack', 'stop'];
  allActions.forEach(function (action) {
    try {
      navigator.mediaSession.setActionHandler(action, function () {
        if (!pttEnabled) return;
        // Toggle: if not holding, start. If holding, end.
        if (pttHolding) {
          endPTT();
        } else {
          startPTT();
        }
      });
    } catch (e) { /* action not supported on this browser */ }
  });
}

function teardownMediaSessionPTT() {
  if (!('mediaSession' in navigator)) return;
  var allActions = ['play', 'pause', 'previoustrack', 'nexttrack', 'stop'];
  allActions.forEach(function (action) {
    try { navigator.mediaSession.setActionHandler(action, null); } catch (e) {}
  });
  navigator.mediaSession.metadata = null;
}

/**
 * Toggle PTT mode on/off. When turning on, shows the hold-to-talk circle
 * and starts/stops SpeechRecognition on demand (browser STT). When turning
 * off, hides the circle and resumes continuous listening. Persists the
 * setting to the server so it survives across calls.
 */
function togglePTTMode() {
  pttEnabled = !pttEnabled;
  const toggleBtn = document.getElementById('voice-btn-ptt-toggle');
  const holdCircle = document.getElementById('voice-hold-circle');
  if (toggleBtn) toggleBtn.classList.toggle('voice-btn--active', pttEnabled);
  if (holdCircle) holdCircle.style.display = pttEnabled ? 'flex' : 'none';
  // Blur the button so subsequent key presses (especially the configured
  // PTT keybind like Space) don't fall through to "activate focused
  // button" browser default behavior and re-toggle PTT. Same fix needed
  // on every button in the overlay — see also toggleYinYangMode and the
  // hold-to-talk button below.
  if (toggleBtn) toggleBtn.blur();
  if (pttEnabled) {
    // Entering PTT mode — stop continuous STT and cancel any pending
    // silence timer. The detector's check() loop also bails on pttEnabled,
    // but a pending silenceTimer from before the toggle would still fire
    // and end the turn mid-hold — clear it explicitly.
    if (recognition) {
      try { recognition.stop(); } catch {}
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    isRecording = false;
  } else {
    // Leaving PTT mode — resume continuous STT if applicable
    if (sttProvider === 'browser' && recognition && !isMuted) {
      try { recognition.start(); } catch {}
    }
  }
  // Persist to server so it survives across calls
  savePTTSetting();
  refreshDisplayState();
}

async function savePTTSetting() {
  try {
    const resp = await fetch('/api/voice/settings');
    const settings = await resp.json();
    settings.pttEnabled = pttEnabled;
    settings.pttKeys = pttKeys;
    await fetch('/api/voice/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
  } catch (err) {
    console.warn('[Voice] Failed to persist PTT setting:', err);
  }
}

function startPTT() {
  if (!pttEnabled) return;
  if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN) return;
  if (sttDebug) console.log('[Voice:ptt] startPTT — sttProvider=' + sttProvider);
  voiceWs.send(JSON.stringify({ type: 'ptt_start' }));
  pttHolding = true;
  const btn = document.getElementById('voice-hold-btn');
  if (btn) btn.classList.add('voice-hold-circle--active');
  // Browser STT mode: start recognition on PTT hold. In server-side STT
  // mode, audio is already flowing — the server clears its buffer on
  // ptt_start so only audio between ptt_start and ptt_end gets transcribed.
  if (sttProvider === 'browser' && recognition) {
    try { recognition.start(); } catch {}
  }
  refreshDisplayState();
}

function endPTT() {
  if (!pttEnabled) return;
  if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN) return;
  if (sttDebug) console.log('[Voice:ptt] endPTT — buffer has ' + sttPhraseBuffer.length + ' phrase(s): "' + sttPhraseBuffer.join(' | ').slice(0, 200) + '"');
  voiceWs.send(JSON.stringify({ type: 'ptt_end' }));
  pttHolding = false;
  const btn = document.getElementById('voice-hold-btn');
  if (btn) btn.classList.remove('voice-hold-circle--active');
  // Browser STT mode: stop recognition on release. Chrome emits any
  // pending final result(s) BEFORE onend fires — so we must defer the
  // flush until onend, otherwise the last phrase gets split into a
  // separate transcript. (Server drops transcripts that arrive while
  // the entity is mid-response, so the split phrase would be lost.)
  //
  // Fallback timeout (500ms) covers the rare case where onend never
  // fires — e.g., recognition was already stopped, or Chrome's speech
  // service is in a weird state.
  if (sttProvider === 'browser' && recognition) {
    pendingEndPTTFlush = true;
    try { recognition.stop(); } catch {}
    if (endPTTFlushTimer) clearTimeout(endPTTFlushTimer);
    endPTTFlushTimer = setTimeout(() => {
      if (pendingEndPTTFlush) {
        if (sttDebug) console.log('[Voice:ptt] endPTT flush — fallback timeout fired (onend did not fire)');
        pendingEndPTTFlush = false;
        flushSttPhraseBuffer();
      }
    }, 500);
  }
  refreshDisplayState();
}

// =============================================================================
// Audio Playback
// =============================================================================

let playbackBuffer = [];
let playbackPlaying = false;
// Set when the daemon signals speaking → idle. The your-turn cue waits
// here until the playback queue actually drains — otherwise it fires
// underneath the tail of the entity's TTS audio and gets masked.
let pendingYourTurnCue = false;
// Carry odd bytes across WebSocket frames. HTTP streaming can split a
// 2-byte Int16 sample across two frames; without this, an odd-byte frame
// throws RangeError in `new Int16Array(buf)` and misaligns every sample
// thereafter — the classic "TV losing signal" static.
let pendingBytes = null;

// First TTS frame seen during this call. Used to log frame size + total
// count once at start of speech, then go quiet so the log doesn't drown
// out everything else during long responses. Reset in cleanup().
let sawFirstTtsFrame = false;
let ttsFrameCount = 0;

// True while the Tauri native mic-capture plugin is running. Set by the
// Tauri-detection branch in openVoiceChat, cleared by cleanup() calling
// stop_capture. Browser mode never sets this.
let nativeCaptureActive = false;

// RMS from most recent native capture frame. Used by VAD when nativeCaptureActive.
let nativeRms = 0;
// Peak RMS since last VAD check. VAD reads every 100ms but frames arrive
// every ~50ms — if we only track the last frame, a brief speech spike can
// be overwritten by a silence frame before VAD sees it.
let nativePeakRms = 0;

function queueAudioFrame(frame) {
  if (isDeafened) return;
  const bytes = frame instanceof ArrayBuffer
    ? new Uint8Array(frame)
    : new Uint8Array(frame.buffer || frame);
  if (!sawFirstTtsFrame) {
    sawFirstTtsFrame = true;
    voiceDebug('tts', `first frame arrived: ${bytes.byteLength} bytes (expect Int16 PCM 16kHz mono = 32ms per 1024 bytes)`);
  }
  ttsFrameCount++;
  // Sample every 50th frame so the log shows progress without spam.
  if (ttsFrameCount % 50 === 0) {
    voiceDebug('tts', `${ttsFrameCount} frames received`);
  }
  const merged = pendingBytes && pendingBytes.byteLength > 0
    ? (() => {
        const m = new Uint8Array(pendingBytes.byteLength + bytes.byteLength);
        m.set(pendingBytes);
        m.set(bytes, pendingBytes.byteLength);
        return m;
      })()
    : bytes;
  const evenLength = merged.byteLength - (merged.byteLength % 2);
  if (evenLength < 2) {
    pendingBytes = merged;
    return;
  }
  pendingBytes = evenLength < merged.byteLength ? merged.slice(evenLength) : null;
  playbackBuffer.push(merged.slice(0, evenLength).buffer);
  if (!playbackPlaying) {
    drainPlaybackBuffer();
  }
}

function drainPlaybackBuffer() {
  if (playbackBuffer.length === 0) {
    playbackPlaying = false;
    // Playback just finished. If the entity is done speaking (state idle)
    // and we have a pending cue, fire it now — the user will hear it clearly
    // because nothing else is playing.
    if (pendingYourTurnCue) {
      pendingYourTurnCue = false;
      playYourTurnCue();
    }
    // Also refresh the display — if pipeline state was idle but we were
    // holding the UI in "Speaking..." because audio was still playing,
    // now we can finally show "Listening".
    refreshDisplayState();
    return;
  }
  playbackPlaying = true;

  const ctx = audioContext;
  if (!ctx) return;

  try {
    const chunk = playbackBuffer.shift();
    if (chunk.byteLength < 2) return drainPlaybackBuffer();
    const float32 = int16ToFloat32(new Int16Array(chunk));
    if (float32.length === 0) return drainPlaybackBuffer();
    const buffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // playbackGain is created upfront in setupAudioCapture, connected
    // through the voice effect chain if configured.
    source.connect(playbackGain);
    source.onended = () => drainPlaybackBuffer();
    source.start();
  } catch (e) {
    console.error('[Voice] Playback error:', e);
    drainPlaybackBuffer();
  }
}

function int16ToFloat32(int16Array) {
  const float32 = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32[i] = int16Array[i] / 0x8000;
  }
  return float32;
}

// =============================================================================
// WebSocket
// =============================================================================

function connectVoiceWs(conversationId) {
  const cfg = document.getElementById('voice-status-cfg');
  let wsUrl = `/api/voice/ws?conversationId=${conversationId}`;
  if (cfg) {
    try {
      const parsed = JSON.parse(cfg.textContent);
      if (parsed.wsUrl) wsUrl = parsed.wsUrl;
    } catch {}
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const fullUrl = `${protocol}//${location.host}${wsUrl}`;

  voiceWs = new WebSocket(fullUrl);
  voiceWs.binaryType = 'arraybuffer';

  voiceWs.onopen = () => {
    voiceDebug('ws', `connected → ${fullUrl}`);
    updateConnectionStatus('active', pttEnabled ? 'PTT ready' : 'Listening');
  };

  voiceWs.onmessage = (event) => {
    if (typeof event.data === 'string') {
      handleVoiceMessage(event.data);
    } else {
      // Binary audio frame from the daemon — TTS playback
      queueAudioFrame(event.data);
    }
  };

  voiceWs.onclose = (event) => {
    voiceDebug('ws', `closed code=${event.code} reason="${event.reason || ''}" clean=${event.wasClean}`);
    updateConnectionStatus('error', 'Disconnected');
    cleanup();
  };

  voiceWs.onerror = () => {
    voiceDebug('ws', 'error event fired (browser gives no detail — check network/proxy/cert)');
    updateConnectionStatus('error', 'Connection error');
  };
}

function handleVoiceMessage(data) {
  try {
    const msg = JSON.parse(data);
    voiceDebug('ws-rx', `type=${msg.type}`);
    switch (msg.type) {
      case 'pong':
        break;

      case 'state':
        // Idle means the daemon finished its turn and isn't going to send
        // more audio for the in-flight response. Drop any odd-byte carry so
        // it can't poison the next sentence (defends against mid-sentence
        // aborts where the server's alignChunks flush didn't run).
        if (msg.state === 'idle' && playbackBuffer.length === 0) {
          pendingBytes = null;
        }
        updateWalkieTalkieState(msg.state);
        break;

      case 'transcript':
        updateTranscript(
          msg.role === 'user'
            ? (globalThis.PsycherosSettings?.userName || 'You')
            : (globalThis.PsycherosSettings?.entityName || 'Assistant'),
          msg.role,
          msg.text,
        );
        break;

      case 'pulse_start':
        // Pulse arrived mid-call — play heartbeat cue + show sticky toast.
        // Toast stays visible until the next idle state (after the entity's
        // Pulse response finishes).
        playPulseCue();
        showPulseToast(msg.name);
        break;

      case 'tool_start':
        // Entity is calling a tool — play ascending chime + add a chip to
        // the tool toast. Multiple parallel tool calls stack vertically.
        playToolChime();
        addToolChip(msg.toolCallId, msg.toolName);
        break;

      case 'tool_end':
        // Tool completed — remove the matching chip.
        removeToolChip(msg.toolCallId);
        break;

      case 'error':
        showVoiceToast(msg.message);
        break;

      case 'session_ended':
        cleanup();
        break;
    }
  } catch {}
}

function updateWalkieTalkieState(state) {
  previousWalkieState = currentWalkieState;
  currentWalkieState = state;
  voiceDebug('state', `${previousWalkieState ?? '(none)'} → ${state}`);

  // End-of-turn cue: when the daemon transitions INTO processing, the user's
  // message has been received and sent to the LLM. Play a soft tick so the
  // user knows they were heard, especially valuable with high-latency setups
  // where the wait until TTS audio can feel uncertain.
  if (state === 'processing' && previousWalkieState !== 'processing') {
    playEndOfTurnCue();
  }

  // Your-turn cue: when the entity finishes speaking (speaking → idle),
  // signal that it's the user's turn. The actual cue fires when the
  // playback queue drains — otherwise it would play under the tail of
  // the entity's TTS audio and get masked. If playback already finished
  // (e.g., the entity's response had no TTS audio), fire immediately.
  if (state === 'idle' && previousWalkieState === 'speaking') {
    if (playbackPlaying || playbackBuffer.length > 0) {
      pendingYourTurnCue = true;
    } else {
      playYourTurnCue();
    }
  }
  // If the user starts recording before the cue fires, cancel the pending
  // cue — no point signaling "your turn" if they're already taking it.
  if (state === 'recording') {
    pendingYourTurnCue = false;
  }

  // Refresh the display from the (possibly new) pipeline state. This
  // helper also considers whether audio is still playing — if so, the
  // display stays "Speaking..." even when pipeline state is idle.
  refreshDisplayState();
}

/**
 * Refresh the status label, waveform muting, and Pulse toast visibility
 * based on the current pipeline state AND whether TTS audio is still
 * playing.
 *
 * Why both: the server emits state=idle as soon as the LLM stream ends
 * and the last TTS sentence flush begins, but the browser's playback
 * queue may still have several seconds of audio chunks waiting to play.
 * Showing "Listening" during that window makes the user think it's their
 * turn and they'll speak over the entity's tail. Treat
 * "pipeline-idle + audio-still-playing" as still-speaking for display
 * purposes.
 */
function refreshDisplayState() {
  const pipelineState = currentWalkieState;
  const audioStillPlaying = playbackPlaying || playbackBuffer.length > 0;
  // Effective state for display: if pipeline says idle but audio is still
  // going, the entity is effectively still speaking.
  const effective = (pipelineState === 'idle' && audioStillPlaying)
    ? 'speaking'
    : pipelineState;

  const stateText = {
    idle: pttEnabled ? 'Hold to talk' : 'Listening',
    recording: 'Recording...',
    processing: 'Thinking...',
    speaking: 'Speaking...',
  };
  updateConnectionStatus('active', stateText[effective] || effective);

  // Waveform muting: greyed out when it's NOT the user's turn to talk.
  //   - Entity's turn (processing/speaking): always greyed
  // Hold-to-talk circle: dim + disable during entity's turn so it's
  // clear the user can't send a message while the entity is busy.
  const holdBtn = document.getElementById('voice-hold-btn');
  if (holdBtn) {
    const entityTurn = effective === 'processing' || effective === 'speaking';
    holdBtn.disabled = entityTurn;
    holdBtn.style.opacity = entityTurn ? '0.35' : '';
    holdBtn.style.pointerEvents = entityTurn ? 'none' : '';
  }

  // Yin Yang text-input send button: disable while entity is mid-response
  // so the user knows typing won't go through until the turn completes.
  // Textarea stays enabled so they can type ahead if they want.
  const entityTurn = effective === 'processing' || effective === 'speaking';
  setSendButtonDisabled(entityTurn);

  // Pulse toast dismiss: only hide when the pipeline is truly idle AND
  // audio has drained. Otherwise the toast vanishes before the entity's
  // Pulse response finishes playing.
  if (pipelineState === 'idle' && !audioStillPlaying) {
    hidePulseToast();
  }
}

/**
 * Play a short sine-wave "tick" through the playback gain node so it
 * respects the playback volume and deafen toggle. ~50ms at 800Hz.
 * Signals "we heard you, thinking now."
 */
function playEndOfTurnCue() {
  if (isDeafened) return;
  const ctx = audioContext;
  if (!ctx || !playbackGain) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 800;
    // Quick attack, short decay — feels like a soft tick rather than a tone
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    osc.connect(gain);
    gain.connect(playbackGain);
    osc.start(now);
    osc.stop(now + 0.06);
  } catch (err) {
    // AudioContext may not be ready, or playback gain missing — non-fatal
    console.warn('[Voice] Failed to play end-of-turn cue:', err);
  }
}

/**
 * Play a soft two-tone descent (880Hz → 660Hz over ~120ms) signaling "your
 * turn, you can talk now." Pairs with `playEndOfTurnCue` — the lower pitch
 * and longer duration make the two cues easy to distinguish by ear, so the
 * user always knows whose turn it is without looking at the screen.
 */
function playYourTurnCue() {
  if (isDeafened) return;
  const ctx = audioContext;
  if (!ctx || !playbackGain) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    // Slide from 880Hz down to 660Hz over the cue — gives it a gentle
    // "descending" feel that reads as "opening up" / inviting a response
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.1);
    // Slightly slower envelope than the end-of-turn tick so it feels less
    // percussive and more like a tone
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain);
    gain.connect(playbackGain);
    osc.start(now);
    osc.stop(now + 0.13);
  } catch (err) {
    console.warn('[Voice] Failed to play your-turn cue:', err);
  }
}

/**
 * Play a "bah-bump" heartbeat rhythm to announce a Pulse arriving during
 * a voice call. Two low-frequency thumps (sine waves with quick attack
 * and decay) close together. Doesn't have to sound organic — just the
 * rhythm signals "something new is happening, pay attention." Distinct
 * from the percussive turn-taking cues.
 */
function playPulseCue() {
  if (isDeafened) return;
  const ctx = audioContext;
  if (!ctx || !playbackGain) return;
  try {
    const thump = (startOffset, freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + startOffset);
      // Quick attack, decay to silence — kick-drum-like thump
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + startOffset + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startOffset + 0.12);
      osc.connect(gain);
      gain.connect(playbackGain);
      osc.start(ctx.currentTime + startOffset);
      osc.stop(ctx.currentTime + startOffset + 0.13);
    };
    // "bah" - lower thump, "bump" - slightly higher, close together
    thump(0, 70);
    thump(0.16, 95);
  } catch (err) {
    console.warn('[Voice] Failed to play Pulse cue:', err);
  }
}

// =============================================================================
// Pulse toast (mid-call Pulse indicator)
// =============================================================================

let pulseToastEl = null;

/**
 * Show the sticky Pulse toast. Stays visible through processing + speaking
 * states so the user can see why the entity said what it said if they
 * look away and back. Hidden when state returns to idle.
 */
// The Pulse heartbeat/ECG-line icon. Matches the icon used in text chat
// (pulseIconSvg in src/pulse/templates.ts) so the visual language is
// consistent across modes.
const PULSE_ICON_SVG = `<svg class="voice-pulse-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`;

function showPulseToast(name) {
  if (!pulseToastEl) {
    pulseToastEl = document.createElement('div');
    pulseToastEl.className = 'voice-pulse-toast';
    document.getElementById('voice-overlay')?.appendChild(pulseToastEl);
  }
  // No "Pulse:" prefix — the icon conveys the type. Just show the name,
  // like text chat's renderPulseMessage does.
  pulseToastEl.innerHTML = `${PULSE_ICON_SVG}<span class="voice-pulse-name">${escapeHtmlAttr(name)}</span>`;
  pulseToastEl.classList.add('voice-pulse-toast--visible');
}

function hidePulseToast() {
  if (pulseToastEl) {
    pulseToastEl.classList.remove('voice-pulse-toast--visible');
  }
}

// Minimal HTML escape for the Pulse name (don't trust the user-defined name)
function escapeHtmlAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// =============================================================================
// Tool toast (mid-call tool activity indicator)
// =============================================================================

/**
 * Play a single sustained sine tone when the entity starts using a tool.
 * Smooth attack (~40ms) and slow exponential decay (~700ms) at a mid-low
 * pitch — feels like a meditation bowl struck softly, rather than a
 * "notification" sound. Peak gain 0.4 (matching the other turn-taking
 * cues), pure sine wave so there's no harsh harmonic content.
 *
 * Lazily creates playbackGain if it doesn't exist — the LLM can emit a
 * tool_call chunk before any TTS audio has flowed, in which case the
 * playback gain node hasn't been set up yet.
 */
function playToolChime() {
  if (isDeafened) return;
  const ctx = audioContext;
  if (!ctx || !playbackGain) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 392; // G4 — warm, low, elegant
    // Smooth attack (no click) → peak → long exponential decay
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.4, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
    osc.connect(gain);
    gain.connect(playbackGain);
    osc.start(now);
    osc.stop(now + 0.72);
  } catch (err) {
    console.warn('[Voice] Failed to play tool chime:', err);
  }
}

let toolToastEl = null;
// Map of toolCallId → chip element, so we can remove chips individually
// when tool_end arrives. Parallel tool calls each get their own chip.
const toolChips = new Map();
// Map of toolCallId → timestamp when chip was added. Used to enforce a
// minimum display time so fast tools (knowledge graph queries, current
// time lookups) don't flash the chip so briefly the user can't register it.
const toolChipAddedAt = new Map();
const TOOL_MIN_DISPLAY_MS = 3000;

// Wrench/tool icon — distinct from the Pulse heartbeat-line icon so the
// two toasts are visually distinguishable even at a glance.
const TOOL_ICON_SVG = `<svg class="voice-tool-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;

function ensureToolToast() {
  if (!toolToastEl) {
    toolToastEl = document.createElement('div');
    toolToastEl.className = 'voice-tool-toast';
    toolToastEl.innerHTML = '';
    document.getElementById('voice-overlay')?.appendChild(toolToastEl);
  }
  return toolToastEl;
}

function addToolChip(toolCallId, toolName) {
  const toast = ensureToolToast();
  // Use the tool's raw name (e.g. "current_time", "web_search"). The
  // browser doesn't have access to the human-readable labels.
  const chip = document.createElement('div');
  chip.className = 'voice-tool-chip';
  chip.dataset.toolCallId = toolCallId;
  chip.innerHTML = `${TOOL_ICON_SVG}<span>${escapeHtmlAttr(toolName)}</span>`;
  toast.appendChild(chip);
  toolChips.set(toolCallId, chip);
  toolChipAddedAt.set(toolCallId, Date.now());
  toast.classList.add('voice-tool-toast--visible');
}

function removeToolChip(toolCallId) {
  const chip = toolChips.get(toolCallId);
  const addedAt = toolChipAddedAt.get(toolCallId);
  const elapsed = addedAt ? Date.now() - addedAt : Infinity;
  const doRemove = () => {
    chip?.remove();
    toolChips.delete(toolCallId);
    toolChipAddedAt.delete(toolCallId);
    if (toolToastEl && toolToastEl.children.length === 0) {
      toolToastEl.classList.remove('voice-tool-toast--visible');
    }
  };
  // If the tool completed too quickly, defer removal so the user has time
  // to register the chip — fast tools (current_time, graph queries) would
  // otherwise flash so briefly the user thinks they imagined it.
  if (elapsed < TOOL_MIN_DISPLAY_MS) {
    setTimeout(doRemove, TOOL_MIN_DISPLAY_MS - elapsed);
  } else {
    doRemove();
  }
}

function clearAllToolChips() {
  if (toolToastEl) {
    toolToastEl.innerHTML = '';
    toolToastEl.classList.remove('voice-tool-toast--visible');
  }
  toolChips.clear();
  toolChipAddedAt.clear();
}

// =============================================================================
// UI Controls
// =============================================================================

function toggleVoiceMute() {
  isMuted = !isMuted;
  const btn = document.getElementById('voice-btn-mute');
  if (btn) {
    btn.classList.toggle('voice-btn--active', isMuted);
    btn.textContent = isMuted ? '🔇' : '🎤';
    btn.setAttribute('aria-label', isMuted ? 'Unmute microphone' : 'Mute microphone');
  }
  if (recognition) {
    if (isMuted) {
      try { recognition.stop(); } catch {}
    } else {
      try { recognition.start(); } catch {}
    }
  }
  if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
    voiceWs.send(JSON.stringify({ type: isMuted ? 'mute' : 'unmute' }));
  }
}

function toggleVoiceDeafen() {
  isDeafened = !isDeafened;
  const btn = document.getElementById('voice-btn-deafen');
  if (btn) {
    btn.classList.toggle('voice-btn--active', isDeafened);
    btn.textContent = isDeafened ? '🔈' : '🔊';
    btn.setAttribute('aria-label', isDeafened ? 'Unmute audio' : 'Mute audio');
  }
}

// =============================================================================
// Yin Yang mode — type instead of speak
// =============================================================================
//
// For when the user can hear (headset on) but can't speak (library, sleeping
// baby, meeting, etc.). Toggles input mode mid-call:
//   voice mode (default) → waveform + mic/SpeechRecognition
//   Yin Yang mode        → text input, mic/recognition paused
//
// The server doesn't know about Yin Yang mode — typed text is sent as the
// same `transcript` message that browser STT uses, so all the existing
// entity-turn / Pulse / tool / state infrastructure works without changes.

let yinYangMode = false;

function toggleYinYangMode() {
  yinYangMode = !yinYangMode;
  const btn = document.getElementById('voice-btn-yinyang');
  if (btn) btn.classList.toggle('voice-btn--active', yinYangMode);
  const textArea = document.getElementById('voice-text-input-area');
  // Blur the toggle button so subsequent spacebar presses don't fall
  // through to "activate focused button" browser default behavior.
  // Without this, the PTT keybind (often Space) would re-toggle Yin
  // Yang mode instead of doing hold-to-talk.
  if (btn) btn.blur();
  if (yinYangMode) {
    // Entering Yin Yang mode — show text input, stop listening via
    // mic/STT (no point if user can't talk).
    if (textArea) textArea.style.display = 'flex';
    // Pause SpeechRecognition if it's running
    if (recognition) {
      try { recognition.stop(); } catch {}
    }
    // Actually stop the mic tracks so the browser releases the hardware
    // mic and the tab indicator disappears — just dropping frames in
    // onAudioProcess leaves the mic indicator showing.
    if (mediaStream) {
      mediaStream.getAudioTracks().forEach((t) => t.stop());
    }
    // Focus the text input so the user can start typing immediately
    setTimeout(() => {
      const input = document.getElementById('voice-text-input');
      if (input) input.focus();
    }, 50);
  } else {
    // Leaving Yin Yang mode — hide text input, re-acquire the mic
    // (server STT only) and resume listening.
    if (textArea) textArea.style.display = 'none';

    if (sttProvider === 'browser') {
      // Browser STT: we never held the mic in the first place (Chrome
      // Android would block SpeechRecognition if we did). Just restart
      // recognition — it manages its own mic access.
      if (!pttEnabled && recognition && !isMuted) {
        try { recognition.start(); } catch {}
      }
    } else {
      // Server-side STT: re-acquire the mic — the tracks were stopped on
      // entry so we need a fresh getUserMedia call. Non-fatal if it fails
      // (permission revoked, etc.) — the call continues in a degraded state.
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
      }).then((stream) => {
        mediaStream = stream;
        // Rebuild the audio graph: the old sourceNode was tied to the
        // stopped stream and is dead. Always reconnect source → analyser
        // (waveform needs it); only reconnect processor for server-side STT.
        if (audioContext) {
          try {
            if (sourceNode) {
              try { sourceNode.disconnect(); } catch {}
            }
            sourceNode = audioContext.createMediaStreamSource(stream);
            if (analyserNode) sourceNode.connect(analyserNode);
            if (processorNode) {
              sourceNode.connect(processorNode);
            }
          } catch {}
        }
      }).catch((err) => {
        console.warn('[Voice] Failed to re-acquire mic after leaving Yin Yang mode:', err);
        showVoiceToast('Could not re-enable microphone — staying in text mode');
        yinYangMode = true;
        if (btn) btn.classList.add('voice-btn--active');
      });
    }
  }
}

// Enter key sends (Shift+Enter for newline)
function handleVoiceTextInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendVoiceTextInput();
  }
}

function sendVoiceTextInput() {
  const input = document.getElementById('voice-text-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN) return;
  voiceWs.send(JSON.stringify({ type: 'transcript', text }));
  input.value = '';
  // Disable the send button immediately with inline styles for guaranteed
  // visual feedback regardless of CSS specificity battles with .voice-btn.
  setSendButtonDisabled(true);
}

function setSendButtonDisabled(disabled) {
  const sendBtn = document.getElementById('voice-text-send-btn');
  if (!sendBtn) return;
  sendBtn.disabled = disabled;
  if (disabled) {
    sendBtn.style.opacity = '0.4';
    sendBtn.style.pointerEvents = 'none';
    sendBtn.style.cursor = 'not-allowed';
  } else {
    sendBtn.style.opacity = '';
    sendBtn.style.pointerEvents = '';
    sendBtn.style.cursor = '';
  }
}

function updateConnectionStatus(state, text) {
  const dot = document.getElementById('voice-status-dot');
  const label = document.getElementById('voice-status-text');
  if (dot) {
    dot.className = 'voice-status-dot' +
      (state === 'connecting' ? ' voice-status-dot--connecting' : '') +
      (state === 'active' ? ' voice-status-dot--active' : '') +
      (state === 'error' ? ' voice-status-dot--error' : '');
  }
  if (label) label.textContent = text;
}

// Latest-exchange blurb under the status row. Overwrites on each new
// transcript — the full history lives in chat after the call ends.
function updateTranscript(speaker, role, text) {
  const el = document.getElementById('voice-transcript');
  if (!el) return;
  const truncated = text.length > 200 ? text.slice(0, 197) + '...' : text;
  const speakerClass = role === 'user'
    ? 'voice-transcript__speaker voice-transcript__speaker--user'
    : 'voice-transcript__speaker voice-transcript__speaker--assistant';
  el.innerHTML =
    `<span class="${speakerClass}">${escapeForTranscript(speaker)}:</span>` +
    `<span>${escapeForTranscript(truncated)}</span>`;
}

function escapeForTranscript(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function showVoiceToast(message) {
  const overlay = document.getElementById('voice-overlay');
  if (!overlay) return;
  const toast = document.createElement('div');
  toast.className = 'voice-toast';
  toast.textContent = message;
  overlay.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function showVoiceBanner(visible) {
  let banner = document.getElementById('voice-banner');
  if (visible && !banner) {
    banner = document.createElement('div');
    banner.className = 'voice-banner';
    banner.id = 'voice-banner';
    banner.innerHTML = '<span>🎤 Voice call in progress</span>';
    const chat = document.getElementById('chat');
    if (chat) chat.prepend(banner);
  } else if (!visible && banner) {
    banner.remove();
  }
}

// =============================================================================
// Keyboard Shortcuts
// =============================================================================

function voiceKeyHandler(e) {
  // Skip when typing in inputs so the PTT key doesn't hijack text entry.
  const tag = e.target?.tagName;
  const isInputLike = tag === 'INPUT' || tag === 'TEXTAREA' ||
    e.target?.isContentEditable;
  if (pttEnabled && !isInputLike && pttKeys.includes(e.code)) {
    if (e.type === 'keydown' && !e.repeat) {
      e.preventDefault();
      startPTT();
    } else if (e.type === 'keyup') {
      e.preventDefault();
      endPTT();
    }
    return;
  }

  // Escape = end call
  if (e.type === 'keydown' && e.code === 'Escape') {
    endVoiceChat();
  }
}

// Mouse button PTT handler — supports bindings like "Mouse3" (back) / "Mouse4" (forward)
function voiceMouseHandler(e) {
  if (!pttEnabled) return;
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  const mouseBinding = 'Mouse' + e.button;
  if (!pttKeys.includes(mouseBinding)) return;
  if (e.type === 'mousedown') {
    e.preventDefault();
    startPTT();
  } else if (e.type === 'mouseup') {
    e.preventDefault();
    endPTT();
  }
}

/**
 * Test the currently-selected voice effect by playing TTS test audio through
 * a temporary effect chain. Called from the "Test Effect" button on the
 * voice profile edit form. Lets the user preview how each effect sounds
 * without starting a full voice call.
 */
async function testVoiceEffect() {
  var effectSelect = document.getElementById('voice-effect');
  if (!effectSelect) return;
  var effect = effectSelect.value || 'none';

  try {
    showToast('Testing ' + (effect === 'none' ? 'no effect' : effect) + '...');
    var resp = await fetch('/api/voice/test-tts', { method: 'POST' });
    if (!resp.ok) {
      showToast('TTS test failed');
      return;
    }
    var arrayBuffer = await resp.arrayBuffer();

    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();

    var audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    var source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    var gain = ctx.createGain();
    gain.gain.value = 1.0;

    if (effect !== 'none') {
      var nodes = buildVoiceEffectChain(ctx, effect);
      source.connect(gain);
      gain.connect(nodes.input);
      nodes.output.connect(ctx.destination);
    } else {
      source.connect(gain);
      gain.connect(ctx.destination);
    }

    source.onended = function () {
      try { ctx.close(); } catch (e) {}
    };
    source.start();
  } catch (err) {
    showToast('Test failed: ' + (err.message || err));
    console.error('[Voice] Effect test failed:', err);
  }
}

// =============================================================================
// Exports (required for HTMX onclick handlers)
// =============================================================================

globalThis.openVoiceChat = openVoiceChat;
globalThis.endVoiceChat = endVoiceChat;
globalThis.togglePTTMode = togglePTTMode;
globalThis.toggleYinYangMode = toggleYinYangMode;
globalThis.handleVoiceTextInputKey = handleVoiceTextInputKey;
globalThis.sendVoiceTextInput = sendVoiceTextInput;
globalThis.startPTT = startPTT;
globalThis.endPTT = endPTT;
globalThis.buildVoiceEffectChain = buildVoiceEffectChain;
globalThis.testVoiceEffect = testVoiceEffect;
