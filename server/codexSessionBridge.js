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

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function normalizeReasoningEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return REASONING_EFFORTS.has(normalized) ? normalized : null;
}

function normalizeReasoningEffortInput(value) {
  const compact = String(value || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!compact) return null;

  if (compact === 'xhigh' || compact === 'exhigh' || compact === 'extrahigh') {
    return 'xhigh';
  }

  return normalizeReasoningEffort(compact);
}

function normalizeModel(value) {
  const model = String(value || '').trim();
  return model || null;
}

function normalizeEffortByModel(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const normalized = {};
  for (const [modelRaw, effortRaw] of Object.entries(value)) {
    const model = normalizeModel(modelRaw);
    const effort = normalizeReasoningEffort(effortRaw);
    if (!model || !effort) continue;
    normalized[model] = effort;
  }
  return normalized;
}

function normalizeFastReturnTarget(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const model = normalizeModel(value.model);
  const effort = normalizeReasoningEffort(value.effort);
  if (!model || !effort) {
    return null;
  }

  return { model, effort };
}

class CodexSessionBridge {
  constructor(options) {
    this.logger = options.logger;
    this.codexBin = options.codexBin || 'codex';
    this.codexCwd = options.codexCwd || process.cwd();
    this.mainModel = options.mainModel || options.model || 'gpt-5.3-codex';
    this.fastModel = options.fastModel || 'gpt-5.3-codex-spark';
    this.sessionGuidance = String(options.sessionGuidance || '').trim();
    const persistedModelState = options.persistedModelState || {};
    this.model = normalizeModel(persistedModelState.activeModel) || this.mainModel;
    this.effortByModel = normalizeEffortByModel(persistedModelState.effortByModel);
    this.fastReturnTarget = normalizeFastReturnTarget(persistedModelState.fastReturnTarget);
    this.onModelStateChange = typeof options.onModelStateChange === 'function'
      ? options.onModelStateChange
      : null;
    this.#setDefaultEffortForModel(this.mainModel, 'medium');
    this.#setDefaultEffortForModel(this.fastModel, 'xhigh');
    this.#setDefaultEffortForModel(this.model, 'medium');
    this.approvalPolicy = options.approvalPolicy || 'never';
    this.sandboxPolicy = options.sandboxPolicy || { type: 'dangerFullAccess' };
    this.sttProvider = String(options.sttProvider || 'none').toLowerCase();
    this.sttApiKey = options.sttApiKey || '';
    this.sttLanguage = options.sttLanguage || 'en';
    this.sttModelId = options.sttModelId || 'scribe_v2_realtime';
    this.sttCommitStrategy = options.sttCommitStrategy || 'vad';
    this.sttVadThreshold = Number.isFinite(options.sttVadThreshold) ? options.sttVadThreshold : null;
    this.sttMinSpeechDurationMs = Number.isFinite(options.sttMinSpeechDurationMs)
      ? options.sttMinSpeechDurationMs
      : null;
    this.sttMinSilenceDurationMs = Number.isFinite(options.sttMinSilenceDurationMs)
      ? options.sttMinSilenceDurationMs
      : null;
    this.sttVadSilenceThresholdSecs = Number.isFinite(options.sttVadSilenceThresholdSecs)
      ? options.sttVadSilenceThresholdSecs
      : null;
    this.enableDefaultThreadResume = Boolean(options.enableDefaultThreadResume);
    this.enablePersistThreadState = Boolean(options.enablePersistThreadState);
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
        effort: this.#getCurrentEffort(),
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
        effort: this.#getCurrentEffort(),
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
      vadThreshold: this.sttVadThreshold,
      minSpeechDurationMs: this.sttMinSpeechDurationMs,
      minSilenceDurationMs: this.sttMinSilenceDurationMs,
      vadSilenceThresholdSecs: this.sttVadSilenceThresholdSecs,
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
      ...this.#threadInstructionOverrides(),
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
        ...this.#threadInstructionOverrides(),
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
      case 'item/started': {
        const item = event?.params?.item;
        if (!item || item.type !== 'contextCompaction') return;

        callbacks.onStatus({
          phase: 'compaction_started',
          detail: 'Compaction started',
          sessionId: this.threadId,
        });
        this.#emitCommandText(callbacks, 'Compaction started.');
        return;
      }
      case 'item/completed': {
        const item = event?.params?.item;
        if (!item) return;

        if (item.type === 'contextCompaction') {
          callbacks.onStatus({
            phase: 'compaction_completed',
            detail: 'Compaction complete',
            sessionId: this.threadId,
          });
          this.#emitCommandText(callbacks, 'Compaction complete.');
          return;
        }

        if (item.type !== 'agentMessage') return;

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

    if (command.name === 'help') {
      this.#emitCommandText(
        callbacks,
        [
          'Commands:',
          '/help - show this help',
          '/status - show runtime status',
          '/stop - interrupt active turn',
          '/reset - start a fresh thread',
          '/debug - show current turn diagnostics',
          '/compact - request thread compaction',
          '/effort [none|minimal|low|medium|high|xhigh] - view or set effort for current model',
          '/spark - toggle fast model on or off',
          '/fast - alias for /spark',
          '/restart <codex|bridge|both> - restart runtime components',
          '/thread - show thread and active turn',
          '/thread new - start a new thread',
        ].join('\n'),
      );
      return true;
    }

    if (command.name === 'status') {
      this.#emitCommandText(callbacks, this.#renderStatus(state));
      return true;
    }

    if (command.name === 'debug') {
      this.#emitCommandText(callbacks, this.#renderDebug(state));
      return true;
    }

    if (command.name === 'stop') {
      return this.#handleStopCommand(state, callbacks);
    }

    if (command.name === 'reset') {
      return this.#handleThreadCommand(state, callbacks, ['new']);
    }

    if (command.name === 'compact') {
      return this.#handleCompactCommand(state, callbacks);
    }

    if (command.name === 'effort') {
      return this.#handleEffortCommand(callbacks, command.args);
    }

    if (command.name === 'spark' || command.name === 'fast') {
      return this.#handleSparkToggleCommand(callbacks);
    }

    if (command.name === 'thread') {
      return this.#handleThreadCommand(state, callbacks, command.args);
    }

    if (command.name !== 'restart') {
      this.#emitCommandText(callbacks, `Unknown command: ${command.name}`);
      return true;
    }

    const targetRaw = String(command.args[0] || '').toLowerCase();
    if (!targetRaw) {
      this.#emitCommandText(callbacks, 'Usage: /restart <codex|bridge|both>');
      return true;
    }
    const targetAliases = {
      codec: 'codex',
      codecs: 'codex',
    };
    const target = targetAliases[targetRaw] || targetRaw;

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

  #renderStatus(state) {
    return [
      'Bridge Status',
      `running: ${state.running}`,
      `thread: ${state.threadId || this.threadId || '(none)'}`,
      `active_turn: ${state.activeTurnId || '(none)'}`,
      `model: ${this.model}`,
      `effort: ${this.#getCurrentEffort()}`,
      `fast_mode: ${this.#isFastModel(this.model)}`,
      `main_model: ${this.mainModel}`,
      `fast_model: ${this.fastModel}`,
      `stt_provider: ${this.sttProvider}`,
      `transport_lost: ${this.transportLost}`,
      `resume_default: ${this.enableDefaultThreadResume}`,
      `persist_thread_state: ${this.enablePersistThreadState}`,
    ].join('\n');
  }

  #renderDebug(state) {
    const draftCount = this.itemDrafts.size;
    const recovering = Boolean(this.recoverPromise);
    return [
      'Bridge Debug',
      `running: ${state.running}`,
      `thread: ${state.threadId || this.threadId || '(none)'}`,
      `active_turn: ${state.activeTurnId || '(none)'}`,
      `transport_lost: ${this.transportLost}`,
      `recovering: ${recovering}`,
      `draft_items: ${draftCount}`,
      `model: ${this.model}`,
      `effort: ${this.#getCurrentEffort()}`,
      `stt_provider: ${this.sttProvider}`,
      `stt_model: ${this.sttModelId}`,
    ].join('\n');
  }

  #setDefaultEffortForModel(model, fallbackEffort) {
    const normalizedModel = normalizeModel(model);
    const normalizedEffort = normalizeReasoningEffort(fallbackEffort);
    if (!normalizedModel || !normalizedEffort) return;
    if (!this.effortByModel[normalizedModel]) {
      this.effortByModel[normalizedModel] = normalizedEffort;
    }
  }

  #getEffortForModel(model) {
    const normalizedModel = normalizeModel(model);
    if (!normalizedModel) return 'medium';
    const saved = normalizeReasoningEffort(this.effortByModel[normalizedModel]);
    if (saved) return saved;
    return normalizedModel === this.fastModel ? 'xhigh' : 'medium';
  }

  #getCurrentEffort() {
    return this.#getEffortForModel(this.model);
  }

  #isFastModel(model) {
    return normalizeModel(model) === this.fastModel;
  }

  #persistModelState() {
    if (!this.onModelStateChange) return;

    try {
      this.onModelStateChange({
        activeModel: this.model,
        effortByModel: { ...this.effortByModel },
        fastReturnTarget: this.fastReturnTarget ? { ...this.fastReturnTarget } : null,
      });
    } catch (error) {
      this.logger?.warn?.('model_state_persist_failed', {
        message: error?.message || String(error),
      });
    }
  }

  #toggleSparkModel() {
    if (this.#isFastModel(this.model)) {
      const target = this.fastReturnTarget;
      this.fastReturnTarget = null;
      const nextModel = normalizeModel(target?.model) || this.mainModel;
      const nextEffort = normalizeReasoningEffort(target?.effort) || this.#getEffortForModel(nextModel);
      this.model = nextModel;
      this.effortByModel[nextModel] = nextEffort;
      this.#persistModelState();
      return {
        enabled: false,
        model: this.model,
        effort: this.#getCurrentEffort(),
      };
    }

    this.fastReturnTarget = {
      model: this.model,
      effort: this.#getCurrentEffort(),
    };
    this.model = this.fastModel;
    this.effortByModel[this.fastModel] = this.#getEffortForModel(this.fastModel);
    this.#persistModelState();
    return {
      enabled: true,
      model: this.model,
      effort: this.#getCurrentEffort(),
    };
  }

  #handleSparkToggleCommand(callbacks) {
    const toggled = this.#toggleSparkModel();
    this.#emitCommandText(
      callbacks,
      toggled.enabled
        ? `Fast mode enabled.\nModel: ${toggled.model}\nEffort: ${toggled.effort}`
        : `Fast mode disabled.\nModel: ${toggled.model}\nEffort: ${toggled.effort}`,
    );
    return true;
  }

  #handleEffortCommand(callbacks, args = []) {
    if (!args.length) {
      this.#emitCommandText(
        callbacks,
        `Model: ${this.model}\nEffort: ${this.#getCurrentEffort()}\nAllowed efforts: none, minimal, low, medium, high, xhigh`,
      );
      return true;
    }

    const effortRaw = args.join(' ');
    const effort = normalizeReasoningEffortInput(effortRaw);
    if (!effort) {
      this.#emitCommandText(callbacks, 'Usage: /effort <none|minimal|low|medium|high|xhigh>');
      return true;
    }

    this.effortByModel[this.model] = effort;
    this.#persistModelState();
    this.#emitCommandText(
      callbacks,
      `Reasoning effort set.\nModel: ${this.model}\nEffort: ${effort}`,
    );
    return true;
  }

  async #handleStopCommand(state, callbacks) {
    if (!state.running || !this.rpc || !this.threadId) {
      this.#emitCommandText(callbacks, 'Session is not running.');
      return true;
    }

    if (!state.activeTurnId) {
      this.#emitCommandText(callbacks, 'Nothing to interrupt.');
      return true;
    }

    try {
      await this.rpc.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: state.activeTurnId,
      }, 30000);
      this.#emitCommandText(callbacks, 'Interrupt requested.');
    } catch (error) {
      const message = error?.message || String(error);
      callbacks.onError({
        code: 'turn_interrupt_failed',
        message,
        recoverable: true,
      });
      this.#emitCommandText(callbacks, `Interrupt failed: ${message}`);
    }

    return true;
  }

  async #handleCompactCommand(state, callbacks) {
    if (!state.running || !this.rpc || !this.threadId) {
      this.#emitCommandText(callbacks, 'No active thread to compact.');
      return true;
    }

    try {
      await this.rpc.request('thread/compact/start', {
        threadId: this.threadId,
      }, 30000);
      this.#emitCommandText(callbacks, `Compaction requested for thread ${this.threadId}`);
    } catch (error) {
      const message = error?.message || String(error);
      callbacks.onError({
        code: 'thread_compact_failed',
        message,
        recoverable: true,
      });
      this.#emitCommandText(callbacks, `Compaction failed: ${message}`);
    }

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

  #threadInstructionOverrides() {
    if (!this.sessionGuidance) {
      return {};
    }

    return {
      developerInstructions: this.sessionGuidance,
    };
  }
}

module.exports = {
  CodexSessionBridge,
};
