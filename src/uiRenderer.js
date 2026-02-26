import {
  MIC_LISTENING,
  MIC_MUTED,
  compactStatusLabel,
} from './uxState.mjs';

export function mergeDeltaText(previous, incoming) {
  const prev = String(previous || '');
  const next = String(incoming || '');

  if (!next) return prev;
  if (!prev) return next;

  if (next.startsWith(prev)) return next;
  if (prev.endsWith(next)) return prev;

  return `${prev}${next}`;
}

function shortenStatus(text) {
  const source = String(text || '').trim();
  if (!source) return '';

  const lowered = source.toLowerCase();
  if (lowered.includes('mic muted')) return 'muted';
  if (lowered.includes('mic listening')) return 'listening';
  if (lowered.includes('stt session started')) return 'stt on';
  if (lowered.includes('stt connected')) return 'stt';
  if (lowered.includes('codex bridge ready')) return 'ready';
  if (lowered.includes('connected to backend')) return 'ready';
  if (lowered.includes('initializing even bridge')) return 'init';
  if (lowered.includes('turn completed')) return 'done';
  if (lowered.includes('turn started')) return 'turn';
  if (lowered.includes('thinking')) return 'think';
  if (lowered.includes('reconnecting')) return 'reconn';
  if (lowered.includes('backend disconnected')) return 'offline';
  if (lowered.includes('websocket error')) return 'ws error';
  if (lowered.includes('manual text submitted')) return 'text';
  if (lowered.includes('stt text submitted')) return 'speech';

  const head = source.split(/[|-]/)[0] || source;
  return head
    .replace(/[_\s]+/g, ' ')
    .trim()
    .slice(0, 12)
    .toLowerCase();
}

export class UiRenderer {
  constructor(options) {
    this.evenBridge = options.evenBridge;
    this.throttleMs = options.throttleMs || 120;
    this.maxChars = Number(options.maxChars || 1500);
    this.minChars = Math.max(120, Number(options.minChars || 450));
    if (this.minChars > this.maxChars) {
      this.minChars = this.maxChars;
    }
    this.contentBudgetStep = Math.max(25, Number(options.contentBudgetStep || 100));
    this.contentProbeSuccessesNeeded = Math.max(1, Number(options.contentProbeSuccessesNeeded || 20));
    this.logger = options.logger || null;

    this.statusText = 'Initializing...';
    this.micState = options.micState || MIC_LISTENING;
    this.connectionState = options.connectionState || 'unknown';
    this.flowState = options.flowState || 'idle';
    this.focusMode = false;

    this.userLiveText = '';
    this.userLiveUpdatedAt = 0;
    this.userLiveStaleMs = options.userLiveStaleMs ?? 0;
    this.userLiveExpiryTimer = null;

    this.turnDrafts = new Map();
    this.latestDraftTurnId = null;
    this.history = [];
    this.currentContentBudget = this.maxChars;
    this.contentFlushSuccesses = 0;

    this.pendingTimer = null;
  }

  reset() {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }

    this.statusText = 'Initializing...';
    this.micState = MIC_LISTENING;
    this.connectionState = 'unknown';
    this.flowState = 'idle';
    this.focusMode = false;

    this.userLiveText = '';
    this.userLiveUpdatedAt = 0;
    if (this.userLiveExpiryTimer) {
      clearTimeout(this.userLiveExpiryTimer);
      this.userLiveExpiryTimer = null;
    }

    this.turnDrafts.clear();
    this.latestDraftTurnId = null;
    this.history = [];
    this.currentContentBudget = this.maxChars;
    this.contentFlushSuccesses = 0;
  }

  setStatus(text) {
    this.statusText = String(text || '');
    this.#scheduleRender();
  }

  setMicState(micState) {
    this.micState = micState || MIC_LISTENING;
    this.#scheduleRender();
  }

  setConnectionState(connectionState) {
    this.connectionState = connectionState || 'unknown';
    this.#scheduleRender();
  }

  setFlowState(flowState) {
    this.flowState = flowState || 'idle';
    this.#scheduleRender();
  }

  setFocusMode(enabled) {
    this.focusMode = Boolean(enabled);
    this.#scheduleRender();
  }

  applyTranscriptDelta(payload) {
    const role = payload?.role === 'user' ? 'user' : 'assistant';
    const chunk = String(payload?.text || '');
    const replace = Boolean(payload?.replace);

    if (role === 'user') {
      if (!chunk && !replace) return;
      this.userLiveText = replace ? chunk : mergeDeltaText(this.userLiveText, chunk);
      this.userLiveUpdatedAt = Date.now();
      this.#armUserLiveExpiry();
      this.#scheduleRender();
      return;
    }

    if (!chunk && !replace) return;
    const turnId = payload?.turnId || 'turn-unknown';
    const merged = replace ? chunk : mergeDeltaText(this.turnDrafts.get(turnId), chunk);
    this.turnDrafts.set(turnId, merged);
    this.latestDraftTurnId = turnId;

    this.#scheduleRender();
  }

  applyTranscriptFinal(payload) {
    const role = payload?.role === 'user' ? 'user' : 'assistant';
    const finalText = String(payload?.text || '').trim();

    if (role === 'user') {
      this.userLiveText = '';
      this.userLiveUpdatedAt = 0;
      if (this.userLiveExpiryTimer) {
        clearTimeout(this.userLiveExpiryTimer);
        this.userLiveExpiryTimer = null;
      }
      if (finalText) {
        this.#appendHistory('user', finalText);
      }
      this.#scheduleRender();
      return;
    }

    const turnId = payload?.turnId || this.latestDraftTurnId || 'turn-unknown';
    const resolvedText = finalText || String(this.turnDrafts.get(turnId) || '').trim();

    this.turnDrafts.delete(turnId);
    if (this.latestDraftTurnId === turnId) {
      this.latestDraftTurnId = null;
    }

    if (resolvedText) {
      let replacedExisting = false;
      for (let i = this.history.length - 1; i >= 0; i -= 1) {
        const item = this.history[i];
        if (item.role !== 'assistant') continue;
        if (!item.turnId || item.turnId !== turnId) continue;
        if (item.text !== resolvedText) {
          this.history[i] = { ...item, text: resolvedText };
        }
        replacedExisting = true;
        break;
      }

      if (!replacedExisting) {
        this.#appendHistory('assistant', resolvedText, { turnId });
      }
    }

    this.#scheduleRender();
  }

  async flushNow(options = {}) {
    const force = Boolean(options?.force);
    const status = this.#composeStatusLine();

    await this.evenBridge.updateStatus(status, { force });
    const attempts = this.#buildContentBudgetAttempts();
    let contentText = '';
    let appliedBudget = null;

    for (const budget of attempts) {
      const candidate = this.#composeContentTextForBudget(budget);
      contentText = candidate;
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.evenBridge.updateContent(candidate, { force });
      if (ok) {
        appliedBudget = budget;
        break;
      }
    }

    if (appliedBudget == null) {
      this.#recordContentFlushFailure();
    } else {
      this.#recordContentFlushSuccess(appliedBudget);
    }

    this.logger?.debug?.('Renderer flush', {
      statusLength: String(status || '').length,
      contentLength: contentText.length,
      focusMode: this.focusMode,
      contentBudget: this.currentContentBudget,
      appliedBudget,
    });
  }

  #appendHistory(role, text, options = {}) {
    const entry = { role, text: String(text || '').trim() };
    if (options.turnId) {
      entry.turnId = String(options.turnId);
    }
    this.history.push(entry);
    if (this.history.length > 24) {
      this.history.splice(0, this.history.length - 24);
    }
  }

  #scheduleRender() {
    if (this.pendingTimer) return;

    this.pendingTimer = setTimeout(async () => {
      this.pendingTimer = null;
      try {
        await this.flushNow();
      } catch {
        // Keep renderer resilient; next update will retry.
      }
    }, this.throttleMs);
  }

  #armUserLiveExpiry() {
    if (this.userLiveStaleMs <= 0) return;

    if (this.userLiveExpiryTimer) {
      clearTimeout(this.userLiveExpiryTimer);
    }

    const scheduledAt = this.userLiveUpdatedAt;
    this.userLiveExpiryTimer = setTimeout(() => {
      this.userLiveExpiryTimer = null;
      if (!this.userLiveText) return;
      if (this.userLiveUpdatedAt !== scheduledAt) return;
      this.userLiveText = '';
      this.userLiveUpdatedAt = 0;
      this.#scheduleRender();
    }, this.userLiveStaleMs);
  }

  #composeStatusLine() {
    const compact = compactStatusLabel({
      micState: this.micState,
      connectionState: this.connectionState,
    });
    const [, connectionRaw = 'initializing'] = compact.split(' | ');
    const micGlyph = this.micState === MIC_MUTED ? '○' : '●';
    const connectionGlyph = connectionRaw === 'connected' ? '■' : '□';
    const flowGlyphMap = {
      up: '↑',
      down: '↓',
      thinking: '~',
      idle: '·',
    };
    const flowGlyph = flowGlyphMap[this.flowState] || '·';
    const activity = shortenStatus(this.statusText);
    let text = 'idle';
    if (this.flowState === 'up') {
      text = 'sending';
    } else if (this.flowState === 'thinking') {
      text = 'thinking';
    } else if (this.flowState === 'down') {
      text = 'streaming';
    } else if (this.micState === MIC_MUTED) {
      text = 'muted';
    } else if (connectionRaw === 'reconnecting') {
      text = 'reconnecting';
    } else if (connectionRaw === 'error' || activity === 'ws error') {
      text = 'ws error';
    } else if (connectionRaw === 'disconnected') {
      text = 'offline';
    } else if (connectionRaw === 'initializing') {
      text = 'initializing';
    } else if (activity && activity !== 'ready' && activity !== 'init') {
      text = activity;
    }
    return `${connectionGlyph}${micGlyph} ${flowGlyph} ${text}`.slice(0, 56);
  }

  #buildNormalBlocks() {
    const blocks = [];

    const liveDraft = this.latestDraftTurnId ? this.turnDrafts.get(this.latestDraftTurnId) : '';
    if (liveDraft) {
      blocks.push(`[codex] ${liveDraft}`);
    }

    if (this.userLiveText) {
      blocks.push(`[you] ${this.userLiveText}`);
    }

    const recent = this.history.slice(-20);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const item = recent[i];
      const label = item.role === 'user' ? 'you' : 'codex';
      blocks.push(`[${label}] ${item.text}`);
    }

    if (blocks.length === 0) {
      return ['[codex] Waiting for transcript and Codex output...'];
    }
    return blocks;
  }

  #buildFocusBlocks() {
    const blocks = [];

    const assistantRecent = this.history
      .filter((item) => item.role === 'assistant')
      .slice(-6);

    const liveDraft = this.latestDraftTurnId ? this.turnDrafts.get(this.latestDraftTurnId) : '';
    if (liveDraft) {
      blocks.push(`[codex] ${liveDraft}`);
    }

    for (let i = assistantRecent.length - 1; i >= 0; i -= 1) {
      const item = assistantRecent[i];
      blocks.push(`[codex] ${item.text}`);
    }

    if (blocks.length === 0) {
      return ['[codex] Waiting for response...'];
    }
    return blocks;
  }

  #buildContentBudgetAttempts() {
    const attempts = [];
    let budget = this.#clampContentBudget(this.currentContentBudget);
    while (budget > this.minChars) {
      attempts.push(budget);
      budget -= this.contentBudgetStep;
    }
    attempts.push(this.minChars);
    return [...new Set(attempts)];
  }

  #recordContentFlushSuccess(usedBudget) {
    const normalized = this.#clampContentBudget(usedBudget);
    if (normalized < this.currentContentBudget) {
      this.currentContentBudget = normalized;
      this.contentFlushSuccesses = 0;
      return;
    }

    if (normalized > this.currentContentBudget) {
      this.currentContentBudget = normalized;
      this.contentFlushSuccesses = 0;
      return;
    }

    this.contentFlushSuccesses += 1;
    if (
      this.currentContentBudget < this.maxChars
      && this.contentFlushSuccesses >= this.contentProbeSuccessesNeeded
    ) {
      this.currentContentBudget = Math.min(this.maxChars, this.currentContentBudget + this.contentBudgetStep);
      this.contentFlushSuccesses = 0;
    }
  }

  #recordContentFlushFailure() {
    this.currentContentBudget = Math.max(this.minChars, this.currentContentBudget - this.contentBudgetStep);
    this.contentFlushSuccesses = 0;
  }

  #clampContentBudget(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return this.maxChars;
    return Math.max(this.minChars, Math.min(this.maxChars, Math.floor(parsed)));
  }

  #composeContentTextForBudget(budget) {
    const target = this.#clampContentBudget(budget);
    const blocks = this.focusMode ? this.#buildFocusBlocks() : this.#buildNormalBlocks();
    return this.#packBlocks(blocks, target);
  }

  #packBlocks(blocks, budget) {
    const sanitized = blocks
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    if (sanitized.length === 0) return '';

    const separator = '\n\n';
    let output = '';
    let truncated = false;

    for (let i = 0; i < sanitized.length; i += 1) {
      const block = sanitized[i];
      const prefix = output ? separator : '';
      const nextLength = output.length + prefix.length + block.length;
      if (nextLength <= budget) {
        output = `${output}${prefix}${block}`;
        continue;
      }

      const remaining = budget - output.length - prefix.length;
      if (remaining > 0) {
        output = `${output}${prefix}${block.slice(0, remaining)}`;
      } else if (!output && budget > 0) {
        output = block.slice(0, budget);
      }
      truncated = true;
      break;
    }

    if (truncated && output && budget - output.length >= 3) {
      output = `${output}...`;
    }

    return output.trim();
  }
}
