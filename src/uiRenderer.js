import {
  MIC_LISTENING,
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

export class UiRenderer {
  constructor(options) {
    this.evenBridge = options.evenBridge;
    this.throttleMs = options.throttleMs || 120;
    this.maxChars = options.maxChars || 2000;
    this.logger = options.logger || null;

    this.statusText = 'Initializing...';
    this.micState = options.micState || MIC_LISTENING;
    this.connectionState = options.connectionState || 'unknown';
    this.focusMode = false;

    this.userLiveText = '';
    this.userLiveUpdatedAt = 0;
    this.userLiveStaleMs = options.userLiveStaleMs || 1800;
    this.userLiveExpiryTimer = null;

    this.turnDrafts = new Map();
    this.latestDraftTurnId = null;
    this.history = [];

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

  setFocusMode(enabled) {
    this.focusMode = Boolean(enabled);
    this.#scheduleRender();
  }

  applyTranscriptDelta(payload) {
    const role = payload?.role === 'user' ? 'user' : 'assistant';
    const chunk = String(payload?.text || '').replace(/\s+/g, ' ').trim();
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

  async flushNow() {
    const statusText = this.#composeStatusText();
    const contentText = this.#composeContentText();

    await this.evenBridge.updateStatus(statusText);
    await this.evenBridge.updateContent(contentText);

    this.logger?.debug?.('Renderer flush', {
      statusLength: statusText.length,
      contentLength: contentText.length,
      focusMode: this.focusMode,
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

  #composeStatusText() {
    const compact = compactStatusLabel({
      micState: this.micState,
      connectionState: this.connectionState,
    });

    if (this.focusMode) {
      return compact;
    }

    if (this.statusText) {
      return `${compact} | ${this.statusText}`.slice(0, 400);
    }

    return compact;
  }

  #composeContentText() {
    const output = this.focusMode ? this.#composeFocusContentText() : this.#composeNormalContentText();

    if (output.length <= this.maxChars) {
      return output;
    }

    // Newest-first rendering means keep the head and trim older tail content.
    return `${output.slice(0, this.maxChars - 3)}...`;
  }

  #composeNormalContentText() {
    const lines = [];

    const liveDraft = this.latestDraftTurnId ? this.turnDrafts.get(this.latestDraftTurnId) : '';
    if (liveDraft) {
      lines.push(`[assistant-live] ${liveDraft}`);
    }

    if (this.userLiveText) {
      lines.push(`[you-live] ${this.userLiveText}`);
    }

    const recent = this.history.slice(-20);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const item = recent[i];
      const label = item.role === 'user' ? 'you' : 'assistant';
      lines.push(`[${label}] ${item.text}`);
    }

    if (lines.length === 0) {
      return '[assistant] Waiting for transcript and Codex output...';
    }

    return lines.join('\n\n').trim();
  }

  #composeFocusContentText() {
    const lines = [];

    const assistantRecent = this.history
      .filter((item) => item.role === 'assistant')
      .slice(-6);

    const liveDraft = this.latestDraftTurnId ? this.turnDrafts.get(this.latestDraftTurnId) : '';
    if (liveDraft) {
      lines.push(`[assistant-live] ${liveDraft}`);
    }

    for (let i = assistantRecent.length - 1; i >= 0; i -= 1) {
      const item = assistantRecent[i];
      lines.push(`[assistant] ${item.text}`);
    }

    if (lines.length === 0) {
      return '[assistant] Waiting for response...';
    }

    return lines.join('\n\n').trim();
  }
}
