const fs = require('node:fs');
const path = require('node:path');

function normalizeThreadId(value) {
  const threadId = String(value || '').trim();
  return threadId || null;
}

class ThreadStateStore {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.filePath = options.filePath || null;
    this.logger = options.logger || null;
    this.threadId = null;
  }

  initialize() {
    if (!this.enabled || !this.filePath) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.threadId = normalizeThreadId(parsed?.threadId);
    } catch {
      this.threadId = null;
    }
  }

  getThreadId() {
    return this.threadId;
  }

  setThreadId(threadId) {
    const normalized = normalizeThreadId(threadId);
    if (!normalized) {
      return;
    }

    this.threadId = normalized;
    if (!this.enabled || !this.filePath) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          {
            threadId: normalized,
            updatedAtMs: Date.now(),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      this.logger?.warn?.('thread_state_write_failed', {
        filePath: this.filePath,
        message: error?.message || String(error),
      });
    }
  }
}

module.exports = {
  ThreadStateStore,
};
