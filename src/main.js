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
  micToggleBtn: document.querySelector('#mic-toggle-btn'),
  submitBtn: document.querySelector('#submit-btn'),
  manualText: document.querySelector('#manual-text'),
  status: document.querySelector('#status'),
  logs: document.querySelector('#logs'),
};

const DEFAULT_WS_URL = import.meta.env.VITE_WS_BASE_URL || '';
const DEFAULT_TOKEN = import.meta.env.VITE_CLIENT_SHARED_TOKEN || '';
const TEXT_UPDATE_THROTTLE_MS = Number(import.meta.env.VITE_TEXT_UPDATE_THROTTLE_MS || 120);
const queryParams = new URLSearchParams(window.location.search);

function isTruthyParam(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const AUTO_START = isTruthyParam(import.meta.env.VITE_AUTO_START) || isTruthyParam(queryParams.get('autostart'));
const EVENT_CAPTURE_MODE = (() => {
  const raw = queryParams.get('capture') || import.meta.env.VITE_EVENT_CAPTURE_MODE || 'text';
  return String(raw).trim().toLowerCase() === 'list' ? 'list' : 'text';
})();

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
let resumeThreadId = safeGetItem('ambient_thread_id', '');

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

const evenBridge = new EvenBridgeController(logger, { eventCaptureMode: EVENT_CAPTURE_MODE });
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

let micState = MIC_LISTENING;
let muteReason = MUTE_REASON_NONE;
let focusMode = false;
let connectionState = CONNECTION_UNKNOWN;
const FLOW_IDLE = 'idle';
const FLOW_UP = 'up';
const FLOW_DOWN = 'down';
const FLOW_THINKING = 'thinking';
let flowState = FLOW_IDLE;

function refreshMicToggleButton() {
  if (!els.micToggleBtn) return;

  els.micToggleBtn.disabled = !started;
  els.micToggleBtn.textContent = micState === MIC_MUTED ? 'Unmute Mic' : 'Mute Mic';
}

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
  renderer.setFlowState(flowState);
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

    if (source === 'ring_click' || source === 'ring_double_click') {
      const ringStatus = micState === MIC_MUTED ? 'Mic muted' : 'Mic listening';
      setStatus(ringStatus);
      renderer.setStatus(ringStatus);
    }
    refreshMicToggleButton();
    return true;
  } catch (error) {
    const message = error?.message || String(error);
    if (nextMicState === MIC_MUTED) {
      // Fallback to app-level (pipeline) mute: stop forwarding frames even if SDK
      // hardware mic close fails on this firmware/build.
      micState = nextMicState;
      muteReason = nextMuteReason;
      renderer.setMicState(micState);
      refreshMicToggleButton();
      logger.warn('Applied local mic mute fallback after audioControl failure', {
        source,
        muteReason,
        message,
      });
      const fallbackStatus = source === 'ring_click' || source === 'web_mic_toggle'
        ? 'Mic muted (local)'
        : 'Mic muted (local fallback)';
      setStatus(fallbackStatus);
      renderer.setStatus(fallbackStatus);
      return true;
    }
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

function setFlowState(nextState, source) {
  const normalized = nextState || FLOW_IDLE;
  if (flowState === normalized) return;

  flowState = normalized;
  renderer.setFlowState(flowState);
  logger.debug('Flow state updated', {
    source,
    flowState,
  });
}

function markFlowIdle(source) {
  setFlowState(FLOW_IDLE, source);
}

async function handleUiEvent(uiEvent) {
  const eventType = Number(uiEvent?.eventType);
  if (!Number.isFinite(eventType)) return;
  const rawEvent = uiEvent?.rawEvent || {};
  logger.debug('Received ring/ui event', {
    eventType,
    source: uiEvent?.source || 'unknown',
    textEventType: rawEvent?.textEvent?.eventType ?? null,
    listEventType: rawEvent?.listEvent?.eventType ?? null,
    sysEventType: rawEvent?.sysEvent?.eventType ?? null,
  });

  if (eventType === OS_EVENT_CLICK) {
    focusMode = toggleFocusMode(focusMode);
    renderer.setFocusMode(focusMode);
    const focusStatus = focusMode ? 'Focus mode enabled' : 'Focus mode disabled';
    setStatus(focusStatus);
    renderer.setStatus(focusStatus);
    logger.info('Applied single-click focus toggle', { focusMode });
    return;
  }

  if (eventType === OS_EVENT_DOUBLE_CLICK) {
    logger.info('Applying double-click mic toggle');
    await toggleMicManually('ring_double_click');
    return;
  }

  if (eventType === 1 || eventType === 2) {
    logger.debug('Scroll event received (SDK-native paging active; app scroll handler disabled)', {
      eventType,
    });
  }
}

wsClient.addEventListener('open', () => {
  logger.info('WebSocket open');
  setConnectionState(CONNECTION_CONNECTED);
  markFlowIdle('ws_open');
  setStatus('Connected to backend');
  renderer.setStatus('Connected to backend');

  const startPayload = {
    appVersion: '0.1.0',
    deviceInfo: cachedDeviceInfo,
    clientTs: Date.now(),
    resumeThreadId: resumeThreadId || undefined,
  };
  const sent = wsClient.send('session.start', startPayload);
  logger.info('Sent session.start', {
    sent,
    wsOpen: wsClient.isOpen(),
    resumeThreadId: resumeThreadId || null,
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
  markFlowIdle('ws_close');
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
  markFlowIdle('ws_reconnecting');
  setStatus(`Reconnecting (attempt ${attempt})...`);
  renderer.setStatus(`Reconnecting in ${Math.ceil(delay / 1000)}s`);

  evaluateAutoMutePolicy('ws_reconnecting').catch(() => {
    // No-op.
  });
});

wsClient.addEventListener('error', (event) => {
  logger.error('WebSocket error', event.detail);
  setConnectionState(CONNECTION_ERROR);
  markFlowIdle('ws_error');
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
      const sessionId = String(msg.payload?.sessionId || '').trim();
      if (sessionId) {
        resumeThreadId = sessionId;
        safeSetItem('ambient_thread_id', resumeThreadId);
      }

      const detail = msg.payload?.detail ? ` - ${msg.payload.detail}` : '';
      const phase = msg.payload?.phase || 'unknown';
      const rollover = msg.payload?.rolloverInSec;
      const suffix = rollover != null ? ` (rollover in ${rollover}s)` : '';
      const text = `${phase}${detail}${suffix}`;
      logger.debug('Received status update', {
        phase,
        detail: msg.payload?.detail || null,
      });
      if (phase === 'thinking') {
        setFlowState(FLOW_THINKING, 'status_thinking');
      }
      if (phase === 'turn_completed') {
        markFlowIdle('status_turn_completed');
      }
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
      if ((msg.payload?.role || 'assistant') === 'assistant' && String(msg.payload?.text || '').trim()) {
        setFlowState(FLOW_DOWN, 'assistant_delta');
      }
      renderer.applyTranscriptDelta(msg.payload);
      break;
    case 'transcript.final':
      logger.debug('Received transcript.final', {
        role: msg.payload?.role || 'assistant',
        turnId: msg.payload?.turnId || null,
        textLength: String(msg.payload?.text || '').length,
      });
      if ((msg.payload?.role || 'assistant') === 'user') {
        setFlowState(FLOW_UP, 'user_final');
      } else {
        // Keep "downstream streaming" active across interleaved assistant outputs.
        // We only return to idle when turn_completed arrives.
        setFlowState(FLOW_DOWN, 'assistant_final');
      }
      renderer.applyTranscriptFinal(msg.payload);
      break;
    case 'metrics':
      logger.debug('Metrics', msg.payload);
      break;
    case 'error': {
      const errorText = `${msg.payload?.code || 'error'}: ${msg.payload?.message || 'Unknown error'}`;
      logger.error('Backend error', msg.payload);
      markFlowIdle('backend_error');
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
    textUpdateThrottleMs: TEXT_UPDATE_THROTTLE_MS,
    eventCaptureMode: EVENT_CAPTURE_MODE,
  });
  renderer.reset();
  audioForwarder.reset();

  micState = MIC_LISTENING;
  muteReason = MUTE_REASON_NONE;
  focusMode = false;
  connectionState = CONNECTION_UNKNOWN;
  flowState = FLOW_IDLE;
  updateRendererModeState();

  setStatus('Initializing Even bridge...');
  renderer.setStatus('Initializing Even bridge...');

  await evenBridge.init();
  try {
    await evenBridge.reapplyLayout();
  } catch (error) {
    logger.warn('Layout reapply failed', {
      message: error?.message || String(error),
    });
  }
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
  refreshMicToggleButton();
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
  markFlowIdle('stop');

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
  flowState = FLOW_IDLE;
  refreshMicToggleButton();

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
  markFlowIdle('teardown');

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

els.micToggleBtn?.addEventListener('click', async () => {
  if (!started) {
    setStatus('Start assistant first.');
    renderer.setStatus('Start assistant first.');
    return;
  }

  try {
    logger.info('Applying web mic toggle');
    await toggleMicManually('web_mic_toggle');
  } catch (error) {
    const message = error?.message || String(error);
    logger.error('Web mic toggle failed', { message });
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

  setFlowState(FLOW_UP, 'manual_text_submit');
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
refreshMicToggleButton();
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
