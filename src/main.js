import { AudioForwarder } from './audioForwarder.js';
import { EvenBridgeController } from './evenBridge.js';
import { UiRenderer } from './uiRenderer.js';
import {
  CONNECTION_CONNECTED,
  CONNECTION_DISCONNECTED,
  CONNECTION_ERROR,
  CONNECTION_RECONNECTING,
  CONNECTION_UNKNOWN,
  MIC_LISTENING,
  MIC_MUTED,
  MUTE_REASON_AUTO,
  MUTE_REASON_NONE,
  OS_EVENT_CLICK,
  OS_EVENT_DOUBLE_CLICK,
  compactStatusLabel,
  mapScrollEventToDelta,
  nextManualMicToggle,
  shouldAutoResume,
  toggleFocusMode,
} from './uxState.mjs';
import { WsClient } from './wsClient.js';

const els = {
  wsUrl: document.querySelector('#ws-url'),
  token: document.querySelector('#token'),
  connectBtn: document.querySelector('#connect-btn'),
  disconnectBtn: document.querySelector('#disconnect-btn'),
  submitBtn: document.querySelector('#submit-btn'),
  manualText: document.querySelector('#manual-text'),
  status: document.querySelector('#status'),
  logs: document.querySelector('#logs'),
};

const DEFAULT_WS_URL = import.meta.env.VITE_WS_BASE_URL || '';
const DEFAULT_TOKEN = import.meta.env.VITE_CLIENT_SHARED_TOKEN || '';
const TEXT_UPDATE_THROTTLE_MS = Number(import.meta.env.VITE_TEXT_UPDATE_THROTTLE_MS || 120);
const CLICK_SUPPRESS_AFTER_DOUBLE_MS = 400;
const queryParams = new URLSearchParams(window.location.search);
const SCROLL_MODE = String(queryParams.get('scroll') || import.meta.env.VITE_SCROLL_MODE || 'normal')
  .trim()
  .toLowerCase();
const NORMALIZED_SCROLL_MODE = SCROLL_MODE === 'normal' ? 'normal' : 'inverted';
const SCROLL_INVERTED = NORMALIZED_SCROLL_MODE === 'inverted';

function isTruthyParam(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const AUTO_START = isTruthyParam(import.meta.env.VITE_AUTO_START) || isTruthyParam(queryParams.get('autostart'));

function safeGetItem(key, fallback = '') {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors (private mode / restricted webview).
  }
}

const wsOverride = queryParams.get('ws');
const tokenOverride = queryParams.get('token');
const storedWsUrl = wsOverride || safeGetItem('ambient_ws_url', DEFAULT_WS_URL);
const storedToken = tokenOverride || safeGetItem('ambient_ws_token', DEFAULT_TOKEN);

if (storedWsUrl) els.wsUrl.value = storedWsUrl;
if (storedToken) els.token.value = storedToken;

function log(level, message, meta = null) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`;
  console.log(line);

  if (els.logs) {
    els.logs.textContent = `${line}\n${els.logs.textContent}`.slice(0, 12000);
  }
}

function setStatus(text) {
  const value = String(text || '');
  els.status.textContent = value;
}

const logger = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  debug: (msg, meta) => log('debug', msg, meta),
};

const evenBridge = new EvenBridgeController(logger);
const wsClient = new WsClient({
  baseUrl: storedWsUrl,
  token: storedToken,
  logger,
});
const audioForwarder = new AudioForwarder({ wsClient, logger });
const renderer = new UiRenderer({
  evenBridge,
  throttleMs: TEXT_UPDATE_THROTTLE_MS,
  logger,
});

let audioUnsubscribe = null;
let uiEventUnsubscribe = null;
let pingTimer = null;
let started = false;
let cachedDeviceInfo = null;
let micTransitionQueue = Promise.resolve();
let lastDoubleClickEventAt = 0;

let micState = MIC_LISTENING;
let muteReason = MUTE_REASON_NONE;
let focusMode = false;
let connectionState = CONNECTION_UNKNOWN;

function sendSessionStop(reason, source) {
  const payload = { reason };
  const sent = wsClient.send('session.stop', payload);
  logger.info('Sent session.stop', {
    reason,
    source,
    sent,
    wsOpen: wsClient.isOpen(),
  });
  return sent;
}

function applyConnectionInputs() {
  const baseUrl = els.wsUrl.value.trim();
  const token = els.token.value.trim();

  safeSetItem('ambient_ws_url', baseUrl);
  safeSetItem('ambient_ws_token', token);

  wsClient.setConnectionInfo({ baseUrl, token });
}

function beginPingLoop() {
  stopPingLoop();
  pingTimer = setInterval(() => {
    wsClient.send('ping', { clientTs: Date.now() });
  }, 15000);
}

function stopPingLoop() {
  if (!pingTimer) return;
  clearInterval(pingTimer);
  pingTimer = null;
}

function updateRendererModeState() {
  renderer.setMicState(micState);
  renderer.setConnectionState(connectionState);
  renderer.setFocusMode(focusMode);
}

function getAutoMuteTrigger() {
  if (
    connectionState === CONNECTION_RECONNECTING ||
    connectionState === CONNECTION_DISCONNECTED ||
    connectionState === CONNECTION_ERROR
  ) {
    return 'backend_disconnected';
  }
  return null;
}

async function applyMicStateTransition(nextMicState, nextMuteReason, source) {
  if (!started && source !== 'startup') {
    return false;
  }

  const shouldForceApply = source === 'startup';
  if (!shouldForceApply && micState === nextMicState && muteReason === nextMuteReason) {
    return true;
  }

  const shouldEnableMic = nextMicState === MIC_LISTENING;
  try {
    await evenBridge.setMicEnabled(shouldEnableMic);
    micState = nextMicState;
    muteReason = nextMuteReason;
    renderer.setMicState(micState);
    logger.info('Mic state updated', {
      source,
      micState,
      muteReason,
      compactStatus: compactStatusLabel({ micState, connectionState }),
    });

    if (source === 'ring_click') {
      const ringStatus = micState === MIC_MUTED ? 'Mic muted' : 'Mic listening';
      setStatus(ringStatus);
      renderer.setStatus(ringStatus);
    }
    return true;
  } catch (error) {
    const message = error?.message || String(error);
    logger.error('Failed to toggle mic state', {
      source,
      targetState: nextMicState,
      message,
    });
    setStatus('Mic toggle failed');
    renderer.setStatus('Mic toggle failed');
    return false;
  }
}

function queueMicTransition(run, source) {
  micTransitionQueue = micTransitionQueue
    .catch(() => {
      // Keep queue alive.
    })
    .then(async () => {
      try {
        return await run();
      } catch (error) {
        logger.error('Queued mic transition failed', {
          source,
          message: error?.message || String(error),
        });
        return false;
      }
    });
  return micTransitionQueue;
}

async function evaluateAutoMutePolicy(source) {
  if (!started) return;

  const trigger = getAutoMuteTrigger();
  if (trigger) {
    if (micState === MIC_LISTENING) {
      await queueMicTransition(
        () => applyMicStateTransition(MIC_MUTED, MUTE_REASON_AUTO, `${source}:${trigger}`),
        `${source}:${trigger}`,
      );
    }
    return;
  }

  if (shouldAutoResume({ micState, muteReason, autoMuteTrigger: trigger })) {
    await queueMicTransition(
      () => applyMicStateTransition(MIC_LISTENING, MUTE_REASON_NONE, `${source}:auto_resume`),
      `${source}:auto_resume`,
    );
  }
}

async function toggleMicManually(source) {
  const next = nextManualMicToggle({ micState, muteReason });
  await queueMicTransition(
    () => applyMicStateTransition(next.micState, next.muteReason, source),
    source,
  );
}

function setConnectionState(nextState) {
  connectionState = nextState;
  renderer.setConnectionState(connectionState);
}

async function handleUiEvent(uiEvent) {
  const eventType = Number(uiEvent?.eventType);
  if (!Number.isFinite(eventType)) return;
  const now = Date.now();
  const rawEvent = uiEvent?.rawEvent || {};
  logger.debug('Received ring/ui event', {
    eventType,
    source: uiEvent?.source || 'unknown',
    textEventType: rawEvent?.textEvent?.eventType ?? null,
    listEventType: rawEvent?.listEvent?.eventType ?? null,
    sysEventType: rawEvent?.sysEvent?.eventType ?? null,
  });

  if (eventType === OS_EVENT_DOUBLE_CLICK) {
    lastDoubleClickEventAt = now;
    focusMode = toggleFocusMode(focusMode);
    renderer.setFocusMode(focusMode);
    logger.info('Toggled focus mode', { focusMode });
    return;
  }

  if (eventType === OS_EVENT_CLICK) {
    if (now - lastDoubleClickEventAt < CLICK_SUPPRESS_AFTER_DOUBLE_MS) {
      logger.debug('Suppressed click because it is adjacent to a double-click', {
        sinceMs: now - lastDoubleClickEventAt,
      });
      return;
    }
    logger.info('Applying single-click mic toggle');
    await toggleMicManually('ring_click');
    return;
  }

  const delta = mapScrollEventToDelta(eventType, renderer.scrollStep, SCROLL_INVERTED);
  if (delta !== 0) {
    const before = renderer.getScrollDebug?.();
    renderer.handleScrollDelta(delta);
    const after = renderer.getScrollDebug?.();
    logger.debug('Applied scroll event', {
      eventType,
      delta,
      scrollMode: NORMALIZED_SCROLL_MODE,
      scrollInverted: SCROLL_INVERTED,
      before,
      after,
    });
  }
}

wsClient.addEventListener('open', () => {
  logger.info('WebSocket open');
  setConnectionState(CONNECTION_CONNECTED);
  setStatus('Connected to backend');
  renderer.setStatus('Connected to backend');

  const startPayload = {
    appVersion: '0.1.0',
    deviceInfo: cachedDeviceInfo,
    clientTs: Date.now(),
  };
  const sent = wsClient.send('session.start', startPayload);
  logger.info('Sent session.start', {
    sent,
    wsOpen: wsClient.isOpen(),
  });

  if (els.submitBtn) {
    els.submitBtn.disabled = false;
  }

  beginPingLoop();
  evaluateAutoMutePolicy('ws_open').catch(() => {
    // No-op.
  });
});

wsClient.addEventListener('close', (event) => {
  logger.warn('WebSocket closed', {
    code: event.detail?.code ?? null,
    reason: event.detail?.reason || null,
    started,
    visibilityState: document.visibilityState,
  });
  stopPingLoop();
  setConnectionState(CONNECTION_DISCONNECTED);
  setStatus('Backend disconnected');
  renderer.setStatus('Backend disconnected. Reconnecting...');
  if (els.submitBtn) {
    els.submitBtn.disabled = true;
  }

  evaluateAutoMutePolicy('ws_close').catch(() => {
    // No-op.
  });
});

wsClient.addEventListener('reconnecting', (event) => {
  const { attempt, delay } = event.detail;
  setConnectionState(CONNECTION_RECONNECTING);
  setStatus(`Reconnecting (attempt ${attempt})...`);
  renderer.setStatus(`Reconnecting in ${Math.ceil(delay / 1000)}s`);

  evaluateAutoMutePolicy('ws_reconnecting').catch(() => {
    // No-op.
  });
});

wsClient.addEventListener('error', (event) => {
  logger.error('WebSocket error', event.detail);
  setConnectionState(CONNECTION_ERROR);
  setStatus(`WebSocket error: ${event.detail.message}`);
  renderer.setStatus(`WebSocket error: ${event.detail.message}`);

  evaluateAutoMutePolicy('ws_error').catch(() => {
    // No-op.
  });
});

wsClient.addEventListener('message', (event) => {
  const msg = event.detail;
  if (!msg?.type) return;

  switch (msg.type) {
    case 'status': {
      const detail = msg.payload?.detail ? ` - ${msg.payload.detail}` : '';
      const phase = msg.payload?.phase || 'unknown';
      const rollover = msg.payload?.rolloverInSec;
      const suffix = rollover != null ? ` (rollover in ${rollover}s)` : '';
      const text = `${phase}${detail}${suffix}`;
      logger.debug('Received status update', {
        phase,
        detail: msg.payload?.detail || null,
      });
      setStatus(text);
      renderer.setStatus(text);
      break;
    }
    case 'transcript.delta':
      logger.debug('Received transcript.delta', {
        role: msg.payload?.role || 'assistant',
        turnId: msg.payload?.turnId || null,
        textLength: String(msg.payload?.text || '').length,
        replace: Boolean(msg.payload?.replace),
      });
      renderer.applyTranscriptDelta(msg.payload);
      break;
    case 'transcript.final':
      logger.debug('Received transcript.final', {
        role: msg.payload?.role || 'assistant',
        turnId: msg.payload?.turnId || null,
        textLength: String(msg.payload?.text || '').length,
      });
      renderer.applyTranscriptFinal(msg.payload);
      break;
    case 'metrics':
      logger.debug('Metrics', msg.payload);
      break;
    case 'error': {
      const errorText = `${msg.payload?.code || 'error'}: ${msg.payload?.message || 'Unknown error'}`;
      logger.error('Backend error', msg.payload);
      setStatus(errorText);
      renderer.setStatus(errorText);
      break;
    }
    case 'pong':
      logger.debug('Received pong', msg.payload);
      break;
    default:
      logger.warn('Unhandled server message', msg);
      break;
  }
});

async function startAssistant() {
  if (started) return;

  applyConnectionInputs();
  logger.info('Starting assistant with runtime config', {
    wsUrl: wsClient.baseUrl,
    hasToken: Boolean(wsClient.token),
    scrollMode: NORMALIZED_SCROLL_MODE,
    scrollInverted: SCROLL_INVERTED,
    textUpdateThrottleMs: TEXT_UPDATE_THROTTLE_MS,
  });
  renderer.reset();
  audioForwarder.reset();

  micState = MIC_LISTENING;
  muteReason = MUTE_REASON_NONE;
  focusMode = false;
  connectionState = CONNECTION_UNKNOWN;
  updateRendererModeState();

  setStatus('Initializing Even bridge...');
  renderer.setStatus('Initializing Even bridge...');

  await evenBridge.init();
  cachedDeviceInfo = await evenBridge.getDeviceInfo();

  audioUnsubscribe = evenBridge.subscribeAudio((audioFrame) => {
    if (micState !== MIC_LISTENING) return;

    const sent = audioForwarder.forwardFrame(audioFrame);
    if (!sent) {
      logger.debug('Dropped local audio frame while disconnected');
    }
  });

  uiEventUnsubscribe = evenBridge.subscribeUiEvents((uiEvent) => {
    handleUiEvent(uiEvent).catch((error) => {
      logger.error('UI event handler failed', {
        message: error?.message || String(error),
      });
    });
  });

  const micEnabled = await applyMicStateTransition(MIC_LISTENING, MUTE_REASON_NONE, 'startup');
  if (!micEnabled) {
    if (audioUnsubscribe) {
      try {
        audioUnsubscribe();
      } catch {
        // No-op.
      }
      audioUnsubscribe = null;
    }
    if (uiEventUnsubscribe) {
      try {
        uiEventUnsubscribe();
      } catch {
        // No-op.
      }
      uiEventUnsubscribe = null;
    }
    throw new Error('Failed to enable microphone at startup');
  }

  started = true;
  micTransitionQueue = Promise.resolve();
  lastDoubleClickEventAt = 0;
  evaluateAutoMutePolicy('startup').catch(() => {
    // No-op.
  });

  renderer.setStatus('Mic active. Connecting backend...');
  wsClient.connect();

  els.connectBtn.disabled = true;
  els.disconnectBtn.disabled = false;
}

async function stopAssistant() {
  if (!started) return;

  started = false;
  lastDoubleClickEventAt = 0;

  sendSessionStop('user_requested_stop', 'stopAssistant');

  wsClient.disconnect();
  stopPingLoop();

  if (audioUnsubscribe) {
    try {
      audioUnsubscribe();
    } catch {
      // No-op.
    }
    audioUnsubscribe = null;
  }

  if (uiEventUnsubscribe) {
    try {
      uiEventUnsubscribe();
    } catch {
      // No-op.
    }
    uiEventUnsubscribe = null;
  }

  await evenBridge.stopMic();
  renderer.reset();

  micState = MIC_LISTENING;
  muteReason = MUTE_REASON_NONE;
  focusMode = false;
  connectionState = CONNECTION_UNKNOWN;

  setStatus('Stopped');
  renderer.setStatus('Stopped');

  els.connectBtn.disabled = false;
  els.disconnectBtn.disabled = true;
  if (els.submitBtn) {
    els.submitBtn.disabled = true;
  }
}

function teardownBestEffort() {
  logger.warn('beforeunload fired', {
    started,
    visibilityState: document.visibilityState,
  });

  started = false;
  lastDoubleClickEventAt = 0;

  sendSessionStop('window_unload', 'beforeunload');
  wsClient.disconnect();
  stopPingLoop();

  if (audioUnsubscribe) {
    try {
      audioUnsubscribe();
    } catch {
      // No-op.
    }
    audioUnsubscribe = null;
  }

  if (uiEventUnsubscribe) {
    try {
      uiEventUnsubscribe();
    } catch {
      // No-op.
    }
    uiEventUnsubscribe = null;
  }

  evenBridge.stopMic().catch(() => {
    // No-op.
  });
  renderer.reset();
}

els.connectBtn.addEventListener('click', async () => {
  try {
    await startAssistant();
  } catch (error) {
    const message = error?.message || String(error);
    logger.error('Failed to start assistant', { message });
    setStatus(`Failed to start: ${message}`);
    renderer.setStatus(`Failed to start: ${message}`);
  }
});

els.disconnectBtn.addEventListener('click', async () => {
  try {
    await stopAssistant();
  } catch (error) {
    const message = error?.message || String(error);
    logger.error('Failed to stop assistant cleanly', { message });
  }
});

function submitManualText() {
  const text = String(els.manualText?.value || '').trim();
  if (!text) return;

  const sent = wsClient.send('text.submit', {
    text,
    clientTs: Date.now(),
  });

  if (!sent) {
    setStatus('Not connected. Start assistant first.');
    renderer.setStatus('Not connected. Start assistant first.');
    return;
  }

  if (els.manualText) {
    els.manualText.value = '';
  }

  logger.info('Manual text submitted');
}

els.submitBtn?.addEventListener('click', () => {
  submitManualText();
});

els.manualText?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitManualText();
  }
});

window.addEventListener('beforeunload', () => {
  teardownBestEffort();
});

window.addEventListener('pagehide', (event) => {
  logger.warn('pagehide fired', {
    persisted: Boolean(event.persisted),
    started,
    visibilityState: document.visibilityState,
  });
});

updateRendererModeState();
setStatus('Ready');
renderer.setStatus('Ready. Tap Start to connect Codex.');

if (AUTO_START) {
  setStatus('Auto-starting assistant...');
  renderer.setStatus('Auto-starting assistant...');
  startAssistant().catch((error) => {
    const message = error?.message || String(error);
    logger.error('Auto-start failed', { message });
    setStatus(`Auto-start failed: ${message}`);
    renderer.setStatus(`Auto-start failed: ${message}`);
  });
}
