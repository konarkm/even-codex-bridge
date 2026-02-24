const { CodexRpcClient } = require('./codexRpcClient');
const { parseSlashCommand } = require('./commands');
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
    this.onRestartRequested = typeof options.onRestartRequested === 'function'
      ? options.onRestartRequested
      : null;

    this.rpc = null;
    this.stt = null;
    this.threadId = null;
    this.clientVersion = '0.1.0';
    this.transportLost = false;
    this.recoverPromise = null;
    this.supportsTurnSteer = true;
    this.itemDrafts = new Map();
  }

  async start(state, callbacks, startPayload = {}) {
    await this.stop(state, callbacks, { sendStatus: false });

    callbacks.onStatus({
      phase: 'starting',
      detail: 'Starting Codex app-server session',
    });

    this.clientVersion = startPayload?.appVersion || this.clientVersion || '0.1.0';
    this.transportLost = false;

    await this.#createAndStartRpc(state, callbacks);
    await this.#startThread(state, callbacks, startPayload?.resumeThreadId);

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
    this.transportLost = false;
    this.recoverPromise = null;
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

    const slashCommand = parseSlashCommand(text);
    if (slashCommand) {
      return this.#handleSlashCommand(state, callbacks, slashCommand);
    }

    if (!state.running) {
      callbacks.onError({
        code: 'session_not_running',
        message: 'Cannot submit text because Codex session is not running',
        recoverable: true,
      });
      return false;
    }

    if (!this.rpc || !this.threadId || this.transportLost) {
      const recovered = await this.#recoverRpcAndThread(state, callbacks, 'submit');
      if (!recovered || !this.rpc || !this.threadId) {
        return false;
      }
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
        // Align with iMessage bridge behavior: if steer fails for a transient
        // runtime reason, clear active turn and fall back to a fresh turn/start.
        state.clearActiveTurn();
        callbacks.onStatus({
          phase: 'turn_steer_fallback',
          detail: 'turn/steer failed; falling back to turn/start',
          sessionId: this.threadId,
        });
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

    let turnRaw;
    try {
      turnRaw = await this.rpc.request('turn/start', {
        threadId: this.threadId,
        input: [asTextInput(text)],
        model: this.model,
        approvalPolicy: this.approvalPolicy,
        sandboxPolicy: this.sandboxPolicy,
        cwd: this.codexCwd,
      }, 120000);
    } catch (error) {
      if (!this.#isRecoverableSessionError(error)) {
        throw error;
      }

      const recovered = await this.#recoverRpcAndThread(state, callbacks, 'turn_start');
      if (!recovered || !this.rpc || !this.threadId) {
        return false;
      }

      turnRaw = await this.rpc.request('turn/start', {
        threadId: this.threadId,
        input: [asTextInput(text)],
        model: this.model,
        approvalPolicy: this.approvalPolicy,
        sandboxPolicy: this.sandboxPolicy,
        cwd: this.codexCwd,
      }, 120000);
    }

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

  async restartCodex(state, callbacks) {
    if (!state.running) {
      throw new Error('Cannot restart codex because session is not running');
    }

    const previousThreadId = state.threadId || this.threadId;

    callbacks.onStatus({
      phase: 'restarting_codex',
      detail: 'Restarting Codex app-server session',
      sessionId: this.threadId,
    });

    this.itemDrafts.clear();
    state.clearActiveTurn();
    await this.#restartRpcOnly(state, callbacks);

    const resumed = await this.#tryResumeThread(state, callbacks, previousThreadId, {
      emitFailStatus: true,
      successDetail: 'Reattached existing thread after codex restart',
      failDetail: 'Existing thread unavailable; starting a new thread',
    });
    if (!resumed) {
      await this.#startThread(state, callbacks);
    }

    callbacks.onStatus({
      phase: 'running',
      detail: 'Codex restarted and ready',
      sessionId: this.threadId,
    });

    return { threadId: this.threadId };
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

  async #createAndStartRpc(state, callbacks) {
    const rpc = new CodexRpcClient({
      codexBin: this.codexBin,
      cwd: this.codexCwd,
      clientName: 'even_codex_bridge',
      clientTitle: 'Even Codex Bridge',
      clientVersion: this.clientVersion,
    });

    this.rpc = rpc;
    this.#wireRpcHandlers(rpc, state, callbacks);
    await rpc.start();
    this.transportLost = false;
  }

  async #startThread(state, callbacks, preferredThreadId = null) {
    if (!this.rpc) {
      throw new Error('Codex RPC is not ready');
    }

    const resumed = await this.#tryResumeThread(state, callbacks, preferredThreadId, {
      emitFailStatus: false,
      successDetail: 'Resumed prior Codex thread',
    });
    if (resumed) {
      return;
    }

    const makeThreadStartParams = () => ({
      model: this.model,
      cwd: this.codexCwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: 'danger-full-access',
      experimentalRawEvents: false,
    });

    let threadRaw;
    try {
      threadRaw = await this.rpc.request('thread/start', makeThreadStartParams());
    } catch (error) {
      if (!this.#isThreadStartTimeout(error)) {
        throw error;
      }

      callbacks.onStatus({
        phase: 'recovering',
        detail: 'thread/start timed out; restarting Codex app-server',
        sessionId: this.threadId,
      });

      await this.#restartRpcOnly(state, callbacks);
      if (!this.rpc) {
        throw new Error('Codex RPC restart failed');
      }
      threadRaw = await this.rpc.request('thread/start', makeThreadStartParams());
    }

    const threadId = threadRaw?.thread?.id;
    if (!threadId) {
      throw new Error('Invalid thread/start response from Codex app-server');
    }

    this.threadId = threadId;
    this.transportLost = false;
    state.markRunning(threadId);
    state.clearActiveTurn();
  }

  #wireRpcHandlers(rpc, state, callbacks) {
    rpc.on('notification', (event) => {
      this.#handleNotification(state, callbacks, event).catch((error) => {
        callbacks.onError({
          code: 'notification_handler_error',
          message: error?.message || String(error),
          recoverable: true,
        });
      });
    });

    rpc.on('serverRequest', (event) => {
      this.#handleServerRequest(state, callbacks, event).catch((error) => {
        callbacks.onError({
          code: 'server_request_handler_error',
          message: error?.message || String(error),
          recoverable: true,
        });
      });
    });

    rpc.on('stderr', (chunk) => {
      this.logger.warn('codex_stderr', {
        clientId: state.clientId,
        chunk: String(chunk).trim(),
      });
    });

    rpc.on('exit', ({ code, signal }) => {
      this.#handleRpcTransportLoss(
        state,
        callbacks,
        rpc,
        `codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      );
    });

    rpc.on('error', (error) => {
      this.#handleRpcTransportLoss(state, callbacks, rpc, error?.message || String(error));
    });
  }

  #handleRpcTransportLoss(state, callbacks, rpc, message) {
    if (this.rpc !== rpc) return;

    this.transportLost = true;
    this.threadId = null;
    this.itemDrafts.clear();
    state.threadId = null;
    state.clearActiveTurn();

    callbacks.onStatus({
      phase: 'codex_disconnected',
      detail: 'Codex app-server disconnected; attempting recovery on next input',
      sessionId: null,
    });

    callbacks.onError({
      code: 'codex_transport_closed',
      message: message || 'Codex app-server transport closed',
      recoverable: true,
    });
  }

  async #restartRpcOnly(state, callbacks) {
    const oldRpc = this.rpc;
    this.rpc = null;
    this.transportLost = true;

    if (oldRpc) {
      try {
        await oldRpc.stop();
      } catch {
        // Ignore cleanup errors.
      }
      oldRpc.removeAllListeners();
    }

    await this.#createAndStartRpc(state, callbacks);
  }

  async #recoverRpcAndThread(state, callbacks, reason) {
    if (this.recoverPromise) {
      return this.recoverPromise;
    }

    this.recoverPromise = (async () => {
      callbacks.onStatus({
        phase: 'recovering',
        detail: `Recovering Codex session (${reason})`,
        sessionId: this.threadId,
      });

      try {
        await this.#restartRpcOnly(state, callbacks);
        await this.#startThread(state, callbacks);
        callbacks.onStatus({
          phase: 'running',
          detail: 'Codex session recovered',
          sessionId: this.threadId,
        });
        return true;
      } catch (error) {
        callbacks.onError({
          code: 'codex_recovery_failed',
          message: error?.message || String(error),
          recoverable: true,
        });
        return false;
      } finally {
        this.recoverPromise = null;
      }
    })();

    return this.recoverPromise;
  }

  async #tryResumeThread(state, callbacks, threadId, options = {}) {
    if (!this.rpc || !threadId) {
      return false;
    }

    const emitFailStatus = options.emitFailStatus ?? true;
    const successDetail = options.successDetail || 'Reattached existing thread';
    const failDetail = options.failDetail || 'Existing thread unavailable; starting a new thread';

    try {
      const resumeRaw = await this.rpc.request('thread/resume', {
        threadId,
      });

      const resumedThreadId = resumeRaw?.thread?.id;
      if (!resumedThreadId) {
        throw new Error('Invalid thread/resume response from Codex app-server');
      }

      this.threadId = resumedThreadId;
      this.transportLost = false;
      state.markRunning(resumedThreadId);
      state.clearActiveTurn();

      callbacks.onStatus({
        phase: 'thread_resumed',
        detail: successDetail,
        sessionId: resumedThreadId,
      });
      return true;
    } catch (error) {
      this.logger.warn('thread_resume_failed', {
        threadId,
        message: error?.message || String(error),
      });
      if (emitFailStatus) {
        callbacks.onStatus({
          phase: 'thread_resume_failed',
          detail: failDetail,
          sessionId: null,
        });
      }
      return false;
    }
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

  #emitCommandText(callbacks, text) {
    callbacks.onTranscriptFinal({
      text: String(text || ''),
      turnId: `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      role: 'assistant',
      ts: Date.now(),
    });
  }

  async #handleSlashCommand(state, callbacks, command) {
    if (!command.supported) {
      this.#emitCommandText(callbacks, `Unknown command: ${command.name}`);
      return true;
    }

    if (command.name === 'thread') {
      return this.#handleThreadCommand(state, callbacks, command.args);
    }

    if (command.name !== 'restart') {
      this.#emitCommandText(callbacks, `Unknown command: ${command.name}`);
      return true;
    }

    const target = String(command.args[0] || '').toLowerCase();
    if (!target) {
      this.#emitCommandText(callbacks, 'Usage: /restart <codex|bridge|both>');
      return true;
    }

    if (target === 'codex') {
      this.#emitCommandText(callbacks, 'Restarting codex now...');
      try {
        const { threadId } = await this.restartCodex(state, callbacks);
        this.#emitCommandText(callbacks, `Codex restarted and back online.\nThread: ${threadId || '(none)'}`);
      } catch (error) {
        const message = error?.message || String(error);
        callbacks.onError({
          code: 'restart_codex_failed',
          message,
          recoverable: true,
        });
        this.#emitCommandText(callbacks, `Codex restart failed: ${message}`);
      }
      return true;
    }

    if (target === 'bridge' || target === 'both') {
      this.#emitCommandText(
        callbacks,
        target === 'both'
          ? 'Restarting bridge and codex now...'
          : 'Restarting bridge now...',
      );

      try {
        await this.stop(state, callbacks, { sendStatus: false });
      } catch {
        // Ignore teardown errors for explicit restart request.
      }

      if (this.onRestartRequested) {
        this.onRestartRequested(target);
      } else {
        callbacks.onError({
          code: 'restart_bridge_unavailable',
          message: 'Bridge restart is not wired in this runtime',
          recoverable: true,
        });
      }
      return true;
    }

    this.#emitCommandText(callbacks, 'Usage: /restart <codex|bridge|both>');
    return true;
  }

  async #handleThreadCommand(state, callbacks, args) {
    const action = String(args[0] || '').toLowerCase();
    if (!action) {
      this.#emitCommandText(
        callbacks,
        `Thread: ${state.threadId || this.threadId || '(none)'}\nActive turn: ${state.activeTurnId || '(none)'}`,
      );
      return true;
    }

    if (action === 'new') {
      if (!state.running || !this.rpc) {
        this.#emitCommandText(callbacks, 'Session is not running.');
        return true;
      }

      this.#emitCommandText(callbacks, 'Starting a new thread...');
      this.itemDrafts.clear();
      state.clearActiveTurn();
      await this.#startThread(state, callbacks);
      this.#emitCommandText(callbacks, `New thread started: ${this.threadId || '(none)'}`);
      return true;
    }

    this.#emitCommandText(callbacks, 'Usage: /thread [new]');
    return true;
  }

  #isUnsupportedTurnSteer(error) {
    const lower = String(error?.message || '').toLowerCase();
    return (
      lower.includes('unknown variant `turn/steer`') ||
      (lower.includes('unknown method') && lower.includes('turn/steer'))
    );
  }

  #isThreadStartTimeout(error) {
    return String(error?.message || '').includes('RPC request timed out: thread/start');
  }

  #isRecoverableSessionError(error) {
    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes('codex app-server stopped') ||
      message.includes('codex app-server exited') ||
      message.includes('codex app-server is not started') ||
      message.includes('transport channel closed') ||
      message.includes('thread not found') ||
      message.includes('rpc request timed out: turn/start')
    );
  }
}

module.exports = {
  CodexSessionBridge,
};
