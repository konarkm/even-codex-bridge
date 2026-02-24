const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ThreadStateStore } = require('../server/threadStateStore');

test('ThreadStateStore persists and reloads thread id when enabled', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-state-'));
  const filePath = path.join(tempDir, 'thread-state.json');

  const storeA = new ThreadStateStore({ enabled: true, filePath });
  storeA.initialize();
  storeA.setThreadId('thread_abc');

  const storeB = new ThreadStateStore({ enabled: true, filePath });
  storeB.initialize();

  assert.equal(storeB.getThreadId(), 'thread_abc');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('ThreadStateStore persists and reloads model state when enabled', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-model-state-'));
  const filePath = path.join(tempDir, 'thread-state.json');

  const storeA = new ThreadStateStore({ enabled: true, filePath });
  storeA.initialize();
  storeA.setModelState({
    activeModel: 'gpt-5.3-codex-spark',
    effortByModel: {
      'gpt-5.3-codex': 'none',
      'gpt-5.3-codex-spark': 'minimal',
    },
    fastReturnTarget: {
      model: 'gpt-5.3-codex',
      effort: 'high',
    },
  });

  const storeB = new ThreadStateStore({ enabled: true, filePath });
  storeB.initialize();

  assert.deepEqual(storeB.getModelState(), {
    activeModel: 'gpt-5.3-codex-spark',
    effortByModel: {
      'gpt-5.3-codex': 'none',
      'gpt-5.3-codex-spark': 'minimal',
    },
    fastReturnTarget: {
      model: 'gpt-5.3-codex',
      effort: 'high',
    },
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('ThreadStateStore keeps memory only when disabled', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-state-disabled-'));
  const filePath = path.join(tempDir, 'thread-state.json');

  const store = new ThreadStateStore({ enabled: false, filePath });
  store.initialize();
  store.setThreadId('thread_local_only');
  store.setModelState({
    activeModel: 'gpt-5.3-codex',
    effortByModel: { 'gpt-5.3-codex': 'medium' },
    fastReturnTarget: null,
  });

  assert.equal(store.getThreadId(), 'thread_local_only');
  assert.deepEqual(store.getModelState(), {
    activeModel: 'gpt-5.3-codex',
    effortByModel: { 'gpt-5.3-codex': 'medium' },
    fastReturnTarget: null,
  });
  assert.equal(fs.existsSync(filePath), false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
