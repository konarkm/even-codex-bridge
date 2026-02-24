require('dotenv').config();

const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const { createLogger } = require('./logger');
const { parseClientMessage, makeOutboundMessage } = require('./protocol');
const { ClientSessionState } = require('./sessionState');
const { CodexSessionBridge } = require('./codexSessionBridge');
const { ThreadStateStore } = require('./threadStateStore');

const logger = createLogger('server');

const PORT = Number(process.env.PORT || 8788);
const CLIENT_SHARED_TOKEN = process.env.CLIENT_SHARED_TOKEN;
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_CWD = process.env.CODEX_CWD || process.cwd();
const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5-codex';
const STT_PROVIDER = process.env.STT_PROVIDER || 'none';
const STT_API_KEY = process.env.STT_API_KEY || '';
const STT_LANGUAGE = process.env.STT_LANGUAGE || 'en';
const STT_MODEL_ID = process.env.STT_MODEL_ID || 'scribe_v2_realtime';
const STT_COMMIT_STRATEGY = process.env.STT_COMMIT_STRATEGY || 'vad';
const STT_VAD_THRESHOLD = parseOptionalNumber(process.env.STT_VAD_THRESHOLD);
const STT_MIN_SPEECH_DURATION_MS = parseOptionalNumber(process.env.STT_MIN_SPEECH_DURATION_MS);
const STT_MIN_SILENCE_DURATION_MS = parseOptionalNumber(process.env.STT_MIN_SILENCE_DURATION_MS);
const STT_VAD_SILENCE_THRESHOLD_SECS = parseOptionalNumber(process.env.STT_VAD_SILENCE_THRESHOLD_SECS);
const ENABLE_DEFAULT_THREAD_RESUME = ['1', 'true', 'yes', 'on']
  .includes(String(process.env.ENABLE_DEFAULT_THREAD_RESUME ?? '1').trim().toLowerCase());
const ENABLE_PERSIST_THREAD_STATE = ['1', 'true', 'yes', 'on']
  .includes(String(process.env.ENABLE_PERSIST_THREAD_STATE || '').trim().toLowerCase());
const THREAD_STATE_FILE = process.env.THREAD_STATE_FILE || '.runtime/thread-state.json';

const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://codex-even-app.example.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://localhost:5173',
  'https://127.0.0.1:5173',
]);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function parseOptionalNumber(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

if (!CLIENT_SHARED_TOKEN) {
  throw new Error('Missing CLIENT_SHARED_TOKEN in environment');
}

const threadStateStore = new ThreadStateStore({
  enabled: ENABLE_PERSIST_THREAD_STATE,
  filePath: path.resolve(process.cwd(), THREAD_STATE_FILE),
  logger,
});
threadStateStore.initialize();

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true);
        return;
      }

      if (
        allowedOrigins.includes('*') ||
        allowedOrigins.includes(origin) ||
        (allowedOrigins.length === 0 && DEFAULT_ALLOWED_ORIGINS.has(origin))
      ) {
        cb(null, true);
        return;
      }

      cb(new Error(`Origin not allowed: ${origin}`));
    },
  }),
);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    model: CODEX_MODEL,
    sttProvider: STT_PROVIDER,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const EXIT_CODE_RESTART = 42;
let shuttingDown = false;
let pendingRestartTarget = null;
const activeConnections = new Set();

function decodeBase64Url(value) {
  try {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(`${normalized}${pad}`, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function extractTokenFromProtocolHeader(headerValue) {
  if (!headerValue) return null;
  const raw = Array.isArray(headerValue) ? headerValue.join(',') : String(headerValue);
  const protocols = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const tokenProtocol = protocols.find((p) => p.startsWith('ambient-auth.'));
  if (!tokenProtocol) return null;

  return decodeBase64Url(tokenProtocol.slice('ambient-auth.'.length));
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes('*')) return true;
  if (allowedOrigins.length === 0) return DEFAULT_ALLOWED_ORIGINS.has(origin);
  return allowedOrigins.includes(origin);
}

function isBenignTeardownError(msgType, message, state, ws) {
  const normalized = String(message || '').toLowerCase();
  const wsClosing = ws.readyState !== ws.OPEN;

  // Benign when teardown races an in-flight start.
  if (
    msgType === 'session.start' &&
    normalized.includes('websocket was closed before the connection was established')
  ) {
    return wsClosing || !state.running;
  }

  // Benign when a stop/disconnect races an in-flight submit.
  if (msgType === 'text.submit' && normalized.includes('codex app-server stopped')) {
    return wsClosing || !state.running;
  }

  return false;
}

async function gracefulExit(exitCode, reason, extra = {}) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info('Server shutdown requested', {
    reason,
    exitCode,
    ...extra,
  });

  const forceExitTimer = setTimeout(() => {
    process.exit(exitCode);
  }, 2000);

  try {
    const stops = [...activeConnections].map((entry) => entry.stop('server_shutdown'));
    await Promise.allSettled(stops);

    await Promise.allSettled([
      new Promise((resolve) => wss.close(() => resolve())),
      new Promise((resolve) => server.close(() => resolve())),
    ]);
  } finally {
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }
}

function scheduleProcessRestart(target, clientId) {
  if (shuttingDown) {
    return;
  }
  if (pendingRestartTarget) {
    return;
  }

  pendingRestartTarget = target;
  logger.info('Runtime restart requested', {
    target,
    clientId,
    exitCode: EXIT_CODE_RESTART,
  });

  setTimeout(() => {
    void gracefulExit(EXIT_CODE_RESTART, 'restart requested', {
      target,
      clientId,
    });
  }, 120);
}

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin)) {
    ws.close(1008, 'origin_not_allowed');
    return;
  }

  const protocolToken = extractTokenFromProtocolHeader(req.headers['sec-websocket-protocol']);
  const headerToken = req.headers['x-client-token'];
  const token = protocolToken || (Array.isArray(headerToken) ? headerToken[0] : headerToken);

  if (token !== CLIENT_SHARED_TOKEN) {
    ws.close(1008, 'unauthorized');
    return;
  }

  const clientId = randomUUID();
  const state = new ClientSessionState(clientId);
  const bridge = new CodexSessionBridge({
    logger: createLogger(`codex-${clientId.slice(0, 6)}`),
    codexBin: CODEX_BIN,
    codexCwd: CODEX_CWD,
    model: CODEX_MODEL,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
    sttProvider: STT_PROVIDER,
    sttApiKey: STT_API_KEY,
    sttLanguage: STT_LANGUAGE,
    sttModelId: STT_MODEL_ID,
    sttCommitStrategy: STT_COMMIT_STRATEGY,
    sttVadThreshold: STT_VAD_THRESHOLD,
    sttMinSpeechDurationMs: STT_MIN_SPEECH_DURATION_MS,
    sttMinSilenceDurationMs: STT_MIN_SILENCE_DURATION_MS,
    sttVadSilenceThresholdSecs: STT_VAD_SILENCE_THRESHOLD_SECS,
    enableDefaultThreadResume: ENABLE_DEFAULT_THREAD_RESUME,
    enablePersistThreadState: ENABLE_PERSIST_THREAD_STATE,
    onRestartRequested: (target) => {
      scheduleProcessRestart(target, clientId);
    },
  });

  logger.info('Client connected', {
    clientId,
    origin: origin || null,
    ip: req.socket.remoteAddress || null,
  });

  function send(type, payload) {
    if (ws.readyState !== ws.OPEN) return;

    try {
      ws.send(makeOutboundMessage(type, payload));
    } catch (error) {
      logger.warn('Failed to send websocket message', {
        clientId,
        type,
        error: error?.message || String(error),
      });
    }
  }

  const callbacks = {
    onStatus(payload) {
      const sessionId = String(payload?.sessionId || '').trim();
      if (sessionId) {
        threadStateStore.setThreadId(sessionId);
      }
      send('status', payload);
    },
    onTranscriptDelta(payload) {
      send('transcript.delta', payload);
    },
    onTranscriptFinal(payload) {
      send('transcript.final', payload);
    },
    onMetrics(payload) {
      send('metrics', payload);
    },
    onError(payload) {
      state.metrics.lastError = payload?.message || null;
      logger.warn('Bridge error', {
        clientId,
        code: payload?.code || 'unknown',
        message: payload?.message || null,
        recoverable: Boolean(payload?.recoverable),
      });
      send('error', payload);
    },
  };

  const metricsTimer = setInterval(() => {
    send('metrics', {
      ...state.metrics,
      running: state.running,
      threadId: state.threadId,
      activeTurnId: state.activeTurnId,
    });
  }, 5000);

  send('status', {
    phase: 'connected',
    detail: 'WebSocket authenticated',
  });

  let closed = false;
  let cleanupPromise = null;
  let messageQueue = Promise.resolve();

  async function cleanupConnection(sendStatus = false) {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    closed = true;
    clearInterval(metricsTimer);
    cleanupPromise = messageQueue
      .catch(() => {
        // Ignore queue failures during teardown.
      })
      .then(async () => {
        try {
          await bridge.stop(state, callbacks, { sendStatus });
        } catch {
          // Ignore teardown errors while disconnecting.
        }
      });

    return cleanupPromise;
  }

  const connectionEntry = {
    clientId,
    stop: async (reason) => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        try {
          ws.close(1012, reason || 'server_shutdown');
        } catch {
          // Ignore close errors.
        }
      }
      await cleanupConnection(false);
    },
  };
  activeConnections.add(connectionEntry);

  async function handleClientMessage(msg) {
    if (msg.type === 'session.start') {
      if (state.running) {
        send('status', {
          phase: 'running',
          detail: 'Session already running',
          sessionId: state.threadId,
        });
        return;
      }

      const clientResumeThreadId = String(msg.payload?.resumeThreadId || '').trim();
      const persistedResumeThreadId = threadStateStore.getThreadId();
      const resumeThreadId = ENABLE_DEFAULT_THREAD_RESUME
        ? (clientResumeThreadId || persistedResumeThreadId || undefined)
        : undefined;

      await bridge.start(state, callbacks, {
        ...msg.payload,
        resumeThreadId,
      });
      return;
    }

    if (msg.type === 'audio.chunk') {
      const audioBuffer = Buffer.from(msg.payload.pcmB64, 'base64');
      if (audioBuffer.length !== msg.payload.byteLength) {
        send('error', {
          code: 'audio_length_mismatch',
          message: 'audio.chunk byteLength does not match decoded payload length',
          recoverable: true,
        });
        return;
      }

      bridge.ingestAudio(state, audioBuffer, callbacks);
      return;
    }

    if (msg.type === 'text.submit') {
      const submittedText = String(msg.payload.text || '');
      callbacks.onTranscriptFinal({
        text: submittedText,
        turnId: `user-${Date.now()}`,
        role: 'user',
        ts: Date.now(),
      });

      await bridge.submitText(state, callbacks, submittedText, 'manual');
      return;
    }

    if (msg.type === 'session.stop') {
      await bridge.stop(state, callbacks, { sendStatus: true });
      state.resetMetrics();
    }
  }

  function handleMessageError(msg, error) {
    const message = error?.message || String(error);
    if (isBenignTeardownError(msg.type, message, state, ws)) {
      logger.info('Suppressed benign teardown race', {
        clientId,
        type: msg.type,
        error: message,
      });
      return;
    }

    logger.error('Unhandled message processing error', {
      clientId,
      type: msg.type,
      error: message,
    });

    send('error', {
      code: 'server_processing_error',
      message,
      recoverable: true,
    });
  }

  ws.on('message', (rawData) => {
    if (closed) return;

    const parsed = parseClientMessage(rawData);
    if (!parsed.ok) {
      send('error', {
        code: parsed.error,
        message: parsed.detail,
        recoverable: true,
      });
      return;
    }

    const msg = parsed.value;

    if (msg.type === 'ping') {
      send('pong', {
        serverTs: Date.now(),
        clientTs: msg.payload.clientTs,
      });
      return;
    }

    // Serialize message processing per-client to avoid start/stop race conditions.
    messageQueue = messageQueue.then(async () => {
      if (closed) return;
      try {
        await handleClientMessage(msg);
      } catch (error) {
        handleMessageError(msg, error);
      }
    });
  });

  ws.on('close', (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString('utf8') : String(reasonBuffer || '');
    void cleanupConnection(false)
      .finally(() => {
        activeConnections.delete(connectionEntry);
        logger.info('Client disconnected', {
          clientId,
          code,
          reason: reason || null,
        });
      });
  });

  ws.on('error', (error) => {
    logger.warn('WebSocket transport error', {
      clientId,
      error: error?.message || String(error),
    });
  });
});

process.on('SIGINT', () => {
  void gracefulExit(0, 'SIGINT');
});

process.on('SIGTERM', () => {
  void gracefulExit(0, 'SIGTERM');
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info('Even Codex bridge server started', {
    port: PORT,
    model: CODEX_MODEL,
    sttProvider: STT_PROVIDER,
    sttModelId: STT_MODEL_ID,
    sttVadTuning: {
      vadThreshold: STT_VAD_THRESHOLD,
      minSpeechDurationMs: STT_MIN_SPEECH_DURATION_MS,
      minSilenceDurationMs: STT_MIN_SILENCE_DURATION_MS,
      vadSilenceThresholdSecs: STT_VAD_SILENCE_THRESHOLD_SECS,
    },
    codexCwd: CODEX_CWD,
    allowedOrigins,
    persistThreadState: ENABLE_PERSIST_THREAD_STATE,
    defaultThreadResume: ENABLE_DEFAULT_THREAD_RESUME,
    threadStateFile: path.resolve(process.cwd(), THREAD_STATE_FILE),
    persistedThreadId: threadStateStore.getThreadId() || null,
  });
});
