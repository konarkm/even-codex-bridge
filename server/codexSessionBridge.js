const { CodexRpcClient } = require('./codexRpcClient');
const { ElevenLabsSttClient } = require('./elevenLabsSttClient');

function asTextInput(text) {
  return {
    type: 'text',
    text: String(text || ''),
  };
}

function mergeDeltaText(previous, incoming) {
  const prev = String(previous || '');
  const next = String(incoming || '');

  if (!next) return prev;
  if (!prev) return next;
  if (next.startsWith(prev)) return next;
  if (prev.endsWith(next)) return prev;
  return `${prev}${next}`;
}

class CodexSessionBridge {
  constructor(options) {
    this.logger = options.logger;
    this.codexBin = options.codexBin || 'codex';
    this.codexCwd = options.codexCwd || process.cwd();
    this.model = options.model || 'gpt-5-codex';
    this.approvalPolicy = options.approvalPolicy || 'never';
    this.sandboxPolicy = options.sandboxPolicy || { type: 'dangerFullAccess' };
    this.sttProvider = String(options.sttProvider || 'none').toLowerCase();
    this.sttApiKey = options.sttApiKey || '';
    this.sttLanguage = options.sttLanguage || 'en';
    this.sttModelId = options.sttModelId || 'scribe_v2_realtime';
    this.sttCommitStrategy = options.sttCommitStrategy || 'vad';

    this.rpc = null;
    this.stt = null;
    this.threadId = null;
    this.supportsTurnSteer = true;
    this.itemDrafts = new Map();
  }

  async start(state, callbacks, startPayload = {}) {
    await this.stop(state, callbacks, { sendStatus: false });

    callbacks.onStatus({
      phase: 'starting',
      detail: 'Starting Codex app-server session',
    });

    this.rpc = new CodexRpcClient({
      codexBin: this.codexBin,
      cwd: this.codexCwd,
      clientName: 'even_codex_bridge',
      clientTitle: 'Even Codex Bridge',
      clientVersion: startPayload?.appVersion || '0.1.0',
    });

    this.rpc.on('notification', (event) => {
      this.#handleNotification(state, callbacks, event).catch((error) => {
        callbacks.onError({
          code: 'notification_handler_error',
          message: error?.message || String(error),
          recoverable: true,
        });
      });
    });

    this.rpc.on('serverRequest', (event) => {
      this.#handleServerRequest(state, callbacks, event).catch((error) => {
        callbacks.onError({
          code: 'server_request_handler_error',
          message: error?.message || String(error),
          recoverable: true,
        });
      });
    });

    this.rpc.on('stderr', (chunk) => {
      this.logger.warn('codex_stderr', {
        clientId: state.clientId,
        chunk: String(chunk).trim(),
      });
    });

    await this.rpc.start();

    const threadRaw = await this.rpc.request('thread/start', {
      model: this.model,
      cwd: this.codexCwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: 'danger-full-access',
      experimentalRawEvents: false,
    });

    const threadId = threadRaw?.thread?.id;
    if (!threadId) {
      throw new Error('Invalid thread/start response from Codex app-server');
    }

    this.threadId = threadId;
    state.markRunning(threadId);

    await this.#startStt(state, callbacks);

    callbacks.onStatus({
      phase: 'running',
      detail: 'Codex bridge ready',
      sessionId: this.threadId,
    });
  }

  async stop(state, callbacks, options = {}) {
    const { sendStatus = true } = options;

    if (this.stt) {
      this.stt.stop();
      this.stt = null;
    }

    if (this.rpc) {
      try {
        await this.rpc.stop();
      } catch {
        // Ignore cleanup errors.
      }
      this.rpc.removeAllListeners();
      this.rpc = null;
    }

    this.threadId = null;
    this.itemDrafts.clear();
    state.markStopped();

    if (sendStatus) {
      callbacks.onStatus({
        phase: 'stopped',
        detail: 'Session stopped',
      });
    }
  }

  async submitText(state, callbacks, rawText, source = 'manual') {
    const text = String(rawText || '').trim();
    if (!text) return false;

    if (!state.running || !this.rpc || !this.threadId) {
      callbacks.onError({
        code: 'session_not_running',
        message: 'Cannot submit text because Codex session is not running',
        recoverable: true,
      });
      return false;
    }

    if (state.activeTurnId && this.supportsTurnSteer) {
      try {
        const steerRaw = await this.rpc.request('turn/steer', {
          threadId: this.threadId,
          expectedTurnId: state.activeTurnId,
          input: [asTextInput(text)],
        }, 60000);

        const steeredTurnId = steerRaw?.turnId || state.activeTurnId;
        state.metrics.turnsSteered += 1;
        callbacks.onStatus({
          phase: 'turn_steered',
          detail: `${source} text appended to active turn`,
          sessionId: this.threadId,
        });

        if (steeredTurnId) {
          state.setActiveTurn(steeredTurnId);
        }

        return true;
      } catch (error) {
        if (this.#isUnsupportedTurnSteer(error)) {
          this.supportsTurnSteer = false;
          callbacks.onStatus({
            phase: 'steer_unavailable',
            detail: 'turn/steer not supported; waiting for current turn completion',
            sessionId: this.threadId,
          });
          return false;
        }

        callbacks.onError({
          code: 'turn_steer_failed',
          message: error?.message || String(error),
          recoverable: true,
        });
        return false;
      }
    }

    if (state.activeTurnId && !this.supportsTurnSteer) {
      callbacks.onError({
        code: 'turn_busy',
        message: 'A turn is already in progress and steer is unavailable',
        recoverable: true,
      });
      return false;
    }

    const turnRaw = await this.rpc.request('turn/start', {
      threadId: this.threadId,
      input: [asTextInput(text)],
      model: this.model,
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: this.sandboxPolicy,
      cwd: this.codexCwd,
    }, 120000);

    const turnId = turnRaw?.turn?.id;
    if (!turnId) {
      throw new Error('Invalid turn/start response from Codex app-server');
    }

    state.setActiveTurn(turnId);
    state.metrics.turnsStarted += 1;

    callbacks.onStatus({
      phase: 'turn_started',
      detail: `${source} text submitted`,
      sessionId: this.threadId,
    });

    return true;
  }

  ingestAudio(state, audioBuffer, callbacks) {
    if (!state.running) return false;

    state.metrics.framesReceived += 1;

    if (!this.stt) {
      state.metrics.framesDropped += 1;
      return false;
    }

    const sent = this.stt.sendAudio(audioBuffer);
    if (!sent) {
      state.metrics.framesDropped += 1;
      callbacks.onError({
        code: 'stt_audio_drop',
        message: 'Dropped audio frame before STT transport was ready',
        recoverable: true,
      });
      return false;
    }

    return true;
  }

  async #startStt(state, callbacks) {
    if (this.sttProvider !== 'elevenlabs') {
      callbacks.onStatus({
        phase: 'stt_disabled',
        detail: `STT provider '${this.sttProvider}' not enabled; use text.submit/manual mode`,
        sessionId: this.threadId,
      });
      return;
    }

    if (!this.sttApiKey) {
      callbacks.onStatus({
        phase: 'stt_disabled',
        detail: 'Missing STT_API_KEY; use text.submit/manual mode',
        sessionId: this.threadId,
      });
      return;
    }

    this.stt = new ElevenLabsSttClient({
      apiKey: this.sttApiKey,
      modelId: this.sttModelId,
      language: this.sttLanguage,
      commitStrategy: this.sttCommitStrategy,
      logger: this.logger,
      onPartial: (text) => {
        callbacks.onTranscriptDelta({
          text,
          turnId: 'user-live',
          role: 'user',
          replace: true,
          ts: Date.now(),
        });
      },
      onFinal: async (text) => {
        try {
          state.metrics.sttFinals += 1;
          callbacks.onTranscriptFinal({
            text,
            turnId: `user-${Date.now()}`,
            role: 'user',
            ts: Date.now(),
          });
          await this.submitText(state, callbacks, text, 'stt');
        } catch (error) {
          callbacks.onError({
            code: 'stt_submit_failed',
            message: error?.message || String(error),
            recoverable: true,
          });
        }
      },
      onError: (error) => {
        callbacks.onError({
          code: 'stt_error',
          message: error?.message || String(error),
          recoverable: true,
        });
      },
      onStatus: (phase, detail) => {
        callbacks.onStatus({
          phase,
          detail,
          sessionId: this.threadId,
        });
      },
    });

    await this.stt.start();
  }

  async #handleNotification(state, callbacks, event) {
    switch (event.method) {
      case 'thread/started': {
        const threadId = event?.params?.thread?.id;
        if (threadId) {
          this.threadId = threadId;
          state.threadId = threadId;
        }
        return;
      }
      case 'turn/started': {
        const turnId = event?.params?.turn?.id;
        if (turnId) {
          state.setActiveTurn(turnId);
          callbacks.onStatus({
            phase: 'thinking',
            detail: 'Codex is generating...',
            sessionId: this.threadId,
          });
        }
        return;
      }
      case 'turn/completed': {
        const status = event?.params?.turn?.status || 'unknown';
        const turnId = event?.params?.turn?.id || state.activeTurnId;
        state.clearActiveTurn();
        callbacks.onStatus({
          phase: 'turn_completed',
          detail: `Turn completed: ${status}`,
          sessionId: this.threadId,
        });

        if (status === 'failed') {
          const message = event?.params?.turn?.error?.message || 'Codex turn failed';
          callbacks.onError({
            code: 'turn_failed',
            message,
            recoverable: true,
          });

          // Emit final fallback text if we have draft content without item/completed.
          for (const [itemId, draft] of this.itemDrafts.entries()) {
            if (draft?.turnId !== turnId || !draft.text) continue;
            callbacks.onTranscriptFinal({ text: draft.text, turnId, ts: Date.now() });
            this.itemDrafts.delete(itemId);
          }
        }
        return;
      }
      case 'item/agentMessage/delta': {
        const itemId = event?.params?.itemId;
        const turnId = event?.params?.turnId || state.activeTurnId || 'turn-unknown';
        const delta = String(event?.params?.delta || '');
        if (!itemId || !delta) return;

        const current = this.itemDrafts.get(itemId) || { turnId, text: '' };
        current.turnId = turnId;
        current.text = mergeDeltaText(current.text, delta);
        this.itemDrafts.set(itemId, current);

        callbacks.onTranscriptDelta({
          text: delta,
          turnId,
          ts: Date.now(),
        });
        return;
      }
      case 'item/completed': {
        const item = event?.params?.item;
        if (!item || item.type !== 'agentMessage') return;

        const turnId = event?.params?.turnId || state.activeTurnId || 'turn-unknown';
        const itemId = item.id;

        const draft = itemId ? this.itemDrafts.get(itemId) : null;
        const finalText = String(item.text || draft?.text || '').trim();
        if (!finalText) return;

        callbacks.onTranscriptFinal({
          text: finalText,
          turnId,
          ts: Date.now(),
        });

        if (itemId) {
          this.itemDrafts.delete(itemId);
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        const usage = event?.params?.tokenUsage;
        if (!usage) return;

        callbacks.onMetrics({
          threadId: this.threadId,
          tokenUsage: usage,
        });
        return;
      }
      case 'error': {
        const message = event?.params?.error?.message || 'Codex app-server emitted error notification';
        callbacks.onError({
          code: 'codex_error',
          message,
          recoverable: true,
        });
        return;
      }
      default:
        return;
    }
  }

  async #handleServerRequest(_state, callbacks, event) {
    if (!this.rpc) return;

    if (event.method === 'item/commandExecution/requestApproval') {
      await this.rpc.respond(event.id, {
        decision: 'accept',
        acceptSettings: { forSession: true },
      });
      callbacks.onStatus({
        phase: 'approval_auto_accept',
        detail: 'Auto-accepted command execution approval request',
        sessionId: this.threadId,
      });
      return;
    }

    if (event.method === 'item/fileChange/requestApproval') {
      await this.rpc.respond(event.id, {
        decision: 'accept',
      });
      callbacks.onStatus({
        phase: 'approval_auto_accept',
        detail: 'Auto-accepted file change approval request',
        sessionId: this.threadId,
      });
      return;
    }

    await this.rpc.respondError(event.id, -32601, `Unsupported server request method: ${event.method}`);
  }

  #isUnsupportedTurnSteer(error) {
    const lower = String(error?.message || '').toLowerCase();
    return (
      lower.includes('unknown variant `turn/steer`') ||
      (lower.includes('unknown method') && lower.includes('turn/steer'))
    );
  }
}

module.exports = {
  CodexSessionBridge,
};
