import { AudioForwarder } from './audioForwarder.js';
import { EvenBridgeController } from './evenBridge.js';
import { UiRenderer } from './uiRenderer.js';
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

const storedWsUrl = safeGetItem('ambient_ws_url', DEFAULT_WS_URL);
const storedToken = safeGetItem('ambient_ws_token', DEFAULT_TOKEN);

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
});

let audioUnsubscribe = null;
let textEventUnsubscribe = null;
let pingTimer = null;
let started = false;
let cachedDeviceInfo = null;

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

wsClient.addEventListener('open', () => {
  logger.info('WebSocket open');
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
});

wsClient.addEventListener('close', (event) => {
  logger.warn('WebSocket closed', {
    code: event.detail?.code ?? null,
    reason: event.detail?.reason || null,
    started,
    visibilityState: document.visibilityState,
  });
  stopPingLoop();
  setStatus('Backend disconnected');
  renderer.setStatus('Backend disconnected. Reconnecting...');
  if (els.submitBtn) {
    els.submitBtn.disabled = true;
  }
});

wsClient.addEventListener('reconnecting', (event) => {
  const { attempt, delay } = event.detail;
  setStatus(`Reconnecting (attempt ${attempt})...`);
  renderer.setStatus(`Reconnecting in ${Math.ceil(delay / 1000)}s`);
});

wsClient.addEventListener('error', (event) => {
  logger.error('WebSocket error', event.detail);
  setStatus(`WebSocket error: ${event.detail.message}`);
  renderer.setStatus(`WebSocket error: ${event.detail.message}`);
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
      setStatus(text);
      renderer.setStatus(text);
      break;
    }
    case 'transcript.delta':
      renderer.applyTranscriptDelta(msg.payload);
      break;
    case 'transcript.final':
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
  renderer.reset();
  audioForwarder.reset();

  setStatus('Initializing Even bridge...');
  renderer.setStatus('Initializing Even bridge...');

  await evenBridge.init();
  cachedDeviceInfo = await evenBridge.getDeviceInfo();

  audioUnsubscribe = evenBridge.subscribeAudio((audioFrame) => {
    const sent = audioForwarder.forwardFrame(audioFrame);
    if (!sent) {
      logger.debug('Dropped local audio frame while disconnected');
    }
  });
  textEventUnsubscribe = evenBridge.subscribeTextEvents((textEvent) => {
    renderer.handleTextEvent(textEvent);
  });

  await evenBridge.startMic();
  renderer.setStatus('Mic active. Connecting backend...');

  wsClient.connect();
  started = true;

  els.connectBtn.disabled = true;
  els.disconnectBtn.disabled = false;
}

async function stopAssistant() {
  if (!started) return;

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
  if (textEventUnsubscribe) {
    try {
      textEventUnsubscribe();
    } catch {
      // No-op.
    }
    textEventUnsubscribe = null;
  }

  await evenBridge.stopMic();
  renderer.reset();

  started = false;
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
  if (textEventUnsubscribe) {
    try {
      textEventUnsubscribe();
    } catch {
      // No-op.
    }
    textEventUnsubscribe = null;
  }

  evenBridge.stopMic().catch(() => {
    // No-op.
  });
  renderer.reset();
  started = false;
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

setStatus('Ready');
renderer.setStatus('Ready. Tap Start to connect Codex.');
