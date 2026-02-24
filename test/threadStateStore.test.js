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

test('ThreadStateStore keeps memory only when disabled', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-state-disabled-'));
  const filePath = path.join(tempDir, 'thread-state.json');

  const store = new ThreadStateStore({ enabled: false, filePath });
  store.initialize();
  store.setThreadId('thread_local_only');

  assert.equal(store.getThreadId(), 'thread_local_only');
  assert.equal(fs.existsSync(filePath), false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
