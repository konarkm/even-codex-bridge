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

function wrapText(text, maxWidth = 56) {
  const input = String(text || '').replace(/\s+/g, ' ').trim();
  if (!input) return [];

  const words = input.split(' ');
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) lines.push(line);

    if (word.length <= maxWidth) {
      line = word;
      continue;
    }

    // Hard-wrap very long tokens.
    let remainder = word;
    while (remainder.length > maxWidth) {
      lines.push(remainder.slice(0, maxWidth));
      remainder = remainder.slice(maxWidth);
    }
    line = remainder;
  }

  if (line) lines.push(line);
  return lines;
}

export class UiRenderer {
  constructor(options) {
    this.evenBridge = options.evenBridge;
    this.throttleMs = options.throttleMs || 120;
    this.maxChars = options.maxChars || 1900;

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

    this.finalAssistantText = '';
    this.finalOffset = 0;
    this.pageChars = options.pageChars || 900;
    this.scrollStep = options.scrollStep || 260;

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
    this.finalAssistantText = '';
    this.finalOffset = 0;
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

  handleScrollDelta(delta) {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.#scrollFinal(delta);
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
      this.finalAssistantText = resolvedText;
      this.finalOffset = 0;
      this.#appendHistory('assistant', resolvedText);
    }

    this.#scheduleRender();
  }

  async flushNow() {
    const { text, contentOffset, contentLength } = this.#composeText();
    await this.evenBridge.updateText(text, {
      contentOffset,
      contentLength,
    });
  }

  #appendHistory(role, text) {
    this.history.push({ role, text });
    if (this.history.length > 12) {
      this.history.splice(0, this.history.length - 12);
    }
  }

  #scrollFinal(delta) {
    if (!this.finalAssistantText) return;

    const maxOffset = Math.max(0, this.finalAssistantText.length - this.pageChars);
    this.finalOffset = Math.min(maxOffset, Math.max(0, this.finalOffset + delta));
    this.#scheduleRender();
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

  #composeText() {
    if (this.focusMode) {
      return this.#composeFocusText();
    }

    const lines = [];

    if (this.statusText) {
      lines.push(`[status] ${this.statusText}`);
      lines.push('');
    }

    if (this.userLiveText) {
      lines.push(`[you] ${this.userLiveText}`);
      lines.push('');
    }

    const liveDraft = this.latestDraftTurnId ? this.turnDrafts.get(this.latestDraftTurnId) : '';
    if (liveDraft) {
      const liveLines = wrapText(liveDraft, 66);
      const visible = liveLines.slice(-2);
      for (const line of visible) {
        lines.push(`[assistant] ${line}`);
      }
      lines.push('');
    } else if (this.finalAssistantText) {
      const windowText = this.finalAssistantText.slice(this.finalOffset, this.finalOffset + this.pageChars);
      lines.push('[assistant]');
      lines.push(windowText);

      if (this.finalAssistantText.length > this.pageChars) {
        const start = this.finalOffset + 1;
        const end = Math.min(this.finalAssistantText.length, this.finalOffset + this.pageChars);
        lines.push('');
        lines.push(`[${start}-${end} / ${this.finalAssistantText.length}]`);
      }
    }

    if (!liveDraft && !this.finalAssistantText && this.history.length > 0) {
      lines.push('');
      const recent = this.history.slice(-2);
      for (const item of recent) {
        const label = item.role === 'user' ? 'you' : 'assistant';
        lines.push(`[${label}] ${item.text}`);
      }
    }

    let output = lines.join('\n').trim();
    if (!output) output = '[status] Waiting for transcript and Codex output...';

    if (output.length > this.maxChars) {
      output = `...${output.slice(output.length - (this.maxChars - 3))}`;
    }

    return {
      text: output,
      contentOffset: this.finalOffset,
      contentLength: this.pageChars,
    };
  }

  #composeFocusText() {
    const lines = [];
    lines.push(`[status] ${compactStatusLabel({ micState: this.micState, connectionState: this.connectionState })}`);
    lines.push('');

    const liveDraft = this.latestDraftTurnId ? this.turnDrafts.get(this.latestDraftTurnId) : '';
    if (liveDraft) {
      const liveLines = wrapText(liveDraft, 66);
      const visible = liveLines.slice(-2);
      for (const line of visible) {
        lines.push(`[assistant] ${line}`);
      }
    } else if (this.finalAssistantText) {
      const windowText = this.finalAssistantText.slice(this.finalOffset, this.finalOffset + this.pageChars);
      lines.push('[assistant]');
      lines.push(windowText);

      if (this.finalAssistantText.length > this.pageChars) {
        const start = this.finalOffset + 1;
        const end = Math.min(this.finalAssistantText.length, this.finalOffset + this.pageChars);
        lines.push('');
        lines.push(`[${start}-${end} / ${this.finalAssistantText.length}]`);
      }
    } else {
      lines.push('[assistant] Waiting for response...');
    }

    let output = lines.join('\n').trim();
    if (!output) output = '[status] listening | initializing';
    if (output.length > this.maxChars) {
      output = `...${output.slice(output.length - (this.maxChars - 3))}`;
    }

    return {
      text: output,
      contentOffset: this.finalOffset,
      contentLength: this.pageChars,
    };
  }
}
