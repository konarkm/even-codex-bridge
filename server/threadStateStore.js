const fs = require('node:fs');
const path = require('node:path');

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function normalizeThreadId(value) {
  const threadId = String(value || '').trim();
  return threadId || null;
}

function normalizeModel(value) {
  const model = String(value || '').trim();
  return model || null;
}

function normalizeReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  return REASONING_EFFORTS.has(effort) ? effort : null;
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

class ThreadStateStore {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.filePath = options.filePath || null;
    this.logger = options.logger || null;
    this.threadId = null;
    this.activeModel = null;
    this.effortByModel = {};
    this.fastReturnTarget = null;
  }

  initialize() {
    if (!this.enabled || !this.filePath) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.threadId = normalizeThreadId(parsed?.threadId);
      this.activeModel = normalizeModel(parsed?.activeModel);
      this.effortByModel = normalizeEffortByModel(parsed?.effortByModel);
      this.fastReturnTarget = normalizeFastReturnTarget(parsed?.fastReturnTarget);
    } catch {
      this.threadId = null;
      this.activeModel = null;
      this.effortByModel = {};
      this.fastReturnTarget = null;
    }
  }

  getThreadId() {
    return this.threadId;
  }

  getModelState() {
    return {
      activeModel: this.activeModel,
      effortByModel: { ...this.effortByModel },
      fastReturnTarget: this.fastReturnTarget ? { ...this.fastReturnTarget } : null,
    };
  }

  setThreadId(threadId) {
    const normalized = normalizeThreadId(threadId);
    if (!normalized) {
      return;
    }

    this.threadId = normalized;
    this.#persist();
  }

  setModelState(state = {}) {
    this.activeModel = normalizeModel(state?.activeModel);
    this.effortByModel = normalizeEffortByModel(state?.effortByModel);
    this.fastReturnTarget = normalizeFastReturnTarget(state?.fastReturnTarget);
    this.#persist();
  }

  #persist() {
    if (!this.enabled || !this.filePath) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          {
            threadId: this.threadId,
            activeModel: this.activeModel,
            effortByModel: this.effortByModel,
            fastReturnTarget: this.fastReturnTarget,
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
