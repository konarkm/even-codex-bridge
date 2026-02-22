require('dotenv').config();

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const { createLogger } = require('./logger');
const { parseClientMessage, makeOutboundMessage } = require('./protocol');
const { ClientSessionState } = require('./sessionState');
const { CodexSessionBridge } = require('./codexSessionBridge');

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

if (!CLIENT_SHARED_TOKEN) {
  throw new Error('Missing CLIENT_SHARED_TOKEN in environment');
}

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
  let messageQueue = Promise.resolve();

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

      await bridge.start(state, callbacks, msg.payload);
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
      callbacks.onTranscriptFinal({
        text: String(msg.payload.text || ''),
        turnId: `user-${Date.now()}`,
        role: 'user',
        ts: Date.now(),
      });
      await bridge.submitText(state, callbacks, msg.payload.text, 'manual');
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

  ws.on('close', () => {
    closed = true;
    clearInterval(metricsTimer);

    messageQueue = messageQueue
      .catch(() => {
        // Ignore queue failures during teardown.
      })
      .then(async () => {
        try {
          await bridge.stop(state, callbacks, { sendStatus: false });
        } catch {
          // Ignore teardown errors while disconnecting.
        }
      })
      .finally(() => {
        logger.info('Client disconnected', { clientId });
      });
  });

  ws.on('error', (error) => {
    logger.warn('WebSocket transport error', {
      clientId,
      error: error?.message || String(error),
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info('Even Codex bridge server started', {
    port: PORT,
    model: CODEX_MODEL,
    sttProvider: STT_PROVIDER,
    sttModelId: STT_MODEL_ID,
    codexCwd: CODEX_CWD,
    allowedOrigins,
  });
});
