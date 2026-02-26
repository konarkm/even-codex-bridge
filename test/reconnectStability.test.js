const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { ClientSessionState } = require('../server/sessionState');

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function loadBridgeWithMockRpc(MockRpcClass) {
  const rpcModulePath = require.resolve('../server/codexRpcClient');
  const bridgeModulePath = require.resolve('../server/codexSessionBridge');
  const originalRpcExports = require(rpcModulePath);

  delete require.cache[bridgeModulePath];
  require.cache[rpcModulePath].exports = { CodexRpcClient: MockRpcClass };
  const { CodexSessionBridge } = require(bridgeModulePath);

  return {
    CodexSessionBridge,
    restore() {
      require.cache[rpcModulePath].exports = originalRpcExports;
      delete require.cache[bridgeModulePath];
    },
  };
}

test('CodexSessionBridge auto-recovers immediately after transport loss', async (t) => {
  class MockRpc extends EventEmitter {
    static nextThread = 1;

    async start() {}

    async stop() {}

    async request(method) {
      if (method === 'thread/start') {
        const id = MockRpc.nextThread++;
        return { thread: { id: `thread-${id}` } };
      }
      if (method === 'thread/resume') {
        throw new Error('thread not found');
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1' } };
      }
      return {};
    }
  }

  const { CodexSessionBridge, restore } = loadBridgeWithMockRpc(MockRpc);
  t.after(restore);

  const statusEvents = [];
  const errorEvents = [];
  const callbacks = {
    onStatus(payload) { statusEvents.push(payload); },
    onTranscriptDelta() {},
    onTranscriptFinal() {},
    onMetrics() {},
    onError(payload) { errorEvents.push(payload); },
  };

  const bridge = new CodexSessionBridge({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    codexBin: 'codex',
    codexCwd: process.cwd(),
    mainModel: 'gpt-5.3-codex',
    fastModel: 'gpt-5.3-codex-spark',
    sttProvider: 'none',
  });
  t.after(async () => {
    await bridge.stop(new ClientSessionState('cleanup'), callbacks, { sendStatus: false });
  });

  const state = new ClientSessionState('client-1');
  await bridge.start(state, callbacks, {});
  const rpcBefore = bridge.rpc;

  rpcBefore.emit('exit', { code: 1, signal: null });
  const recovered = await waitFor(
    () => statusEvents.some((entry) => entry.phase === 'running' && entry.detail === 'Codex session recovered'),
    5000,
  );

  assert.equal(recovered, true);
  assert.equal(statusEvents.some((entry) => entry.phase === 'codex_disconnected'), true);
  assert.equal(statusEvents.some((entry) => entry.phase === 'recovering'), true);
  assert.equal(errorEvents.some((entry) => entry.code === 'codex_transport_closed'), true);
  assert.notEqual(bridge.rpc, rpcBefore);
});

test('CodexSessionBridge de-duplicates transport loss counters/events for the same outage', async (t) => {
  class MockRpc extends EventEmitter {
    async start() {}

    async stop() {}

    async request(method) {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'thread/resume') {
        throw new Error('thread not found');
      }
      return {};
    }
  }

  const { CodexSessionBridge, restore } = loadBridgeWithMockRpc(MockRpc);
  t.after(restore);

  const statusEvents = [];
  const errorEvents = [];
  const callbacks = {
    onStatus(payload) { statusEvents.push(payload); },
    onTranscriptDelta() {},
    onTranscriptFinal() {},
    onMetrics() {},
    onError(payload) { errorEvents.push(payload); },
  };

  const bridge = new CodexSessionBridge({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    codexBin: 'codex',
    codexCwd: process.cwd(),
    mainModel: 'gpt-5.3-codex',
    fastModel: 'gpt-5.3-codex-spark',
    sttProvider: 'none',
  });
  const state = new ClientSessionState('client-dup-loss');
  await bridge.start(state, callbacks, {});
  t.after(async () => {
    await bridge.stop(state, callbacks, { sendStatus: false });
  });

  const rpcBefore = bridge.rpc;
  rpcBefore.emit('exit', { code: 1, signal: null });
  rpcBefore.emit('error', new Error('transport closed'));

  const sawDisconnect = await waitFor(
    () => statusEvents.some((entry) => entry.phase === 'codex_disconnected'),
    5000,
  );
  assert.equal(sawDisconnect, true);
  assert.equal(state.metrics.codexTransportLosses, 1);
  assert.equal(errorEvents.filter((entry) => entry.code === 'codex_transport_closed').length, 1);
});

test('CodexSessionBridge emits compaction_failed status and transcript text on compact failure', async (t) => {
  class MockRpc extends EventEmitter {
    static compactFail = false;

    async start() {}

    async stop() {}

    async request(method) {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-compact' } };
      }
      if (method === 'thread/compact/start') {
        if (MockRpc.compactFail) {
          throw new Error('compact failed hard');
        }
        return {};
      }
      return {};
    }
  }

  const { CodexSessionBridge, restore } = loadBridgeWithMockRpc(MockRpc);
  t.after(restore);

  const statusEvents = [];
  const errorEvents = [];
  const transcriptFinals = [];
  const callbacks = {
    onStatus(payload) { statusEvents.push(payload); },
    onTranscriptDelta() {},
    onTranscriptFinal(payload) { transcriptFinals.push(payload); },
    onMetrics() {},
    onError(payload) { errorEvents.push(payload); },
  };

  const bridge = new CodexSessionBridge({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    codexBin: 'codex',
    codexCwd: process.cwd(),
    mainModel: 'gpt-5.3-codex',
    fastModel: 'gpt-5.3-codex-spark',
    sttProvider: 'none',
  });
  const state = new ClientSessionState('client-2');
  await bridge.start(state, callbacks, {});
  t.after(async () => {
    await bridge.stop(state, callbacks, { sendStatus: false });
  });

  MockRpc.compactFail = true;
  await bridge.submitText(state, callbacks, '/compact', 'manual');
  MockRpc.compactFail = false;

  assert.equal(statusEvents.some((entry) => entry.phase === 'compaction_failed'), true);
  assert.equal(errorEvents.some((entry) => entry.code === 'thread_compact_failed'), true);
  assert.equal(
    transcriptFinals.some((entry) => String(entry.text || '').includes('Compaction failed: compact failed hard')),
    true,
  );
});

test('CodexSessionBridge logs sampled drop summary for non-primary events', async (t) => {
  class MockRpc extends EventEmitter {
    async start() {}

    async stop() {}

    async request(method) {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-primary' } };
      }
      return {};
    }
  }

  const infoLogs = [];
  const { CodexSessionBridge, restore } = loadBridgeWithMockRpc(MockRpc);
  t.after(restore);

  const bridge = new CodexSessionBridge({
    logger: {
      debug() {},
      warn() {},
      error() {},
      info(message, payload) {
        infoLogs.push({ message, payload });
      },
    },
    codexBin: 'codex',
    codexCwd: process.cwd(),
    mainModel: 'gpt-5.3-codex',
    fastModel: 'gpt-5.3-codex-spark',
    sttProvider: 'none',
  });

  const callbacks = {
    onStatus() {},
    onTranscriptDelta() {},
    onTranscriptFinal() {},
    onMetrics() {},
    onError() {},
  };
  const state = new ClientSessionState('client-3');
  await bridge.start(state, callbacks, {});
  t.after(async () => {
    await bridge.stop(state, callbacks, { sendStatus: false });
  });

  bridge.dropMetricLastSummaryAtMs = Date.now() - 61000;
  bridge.dropMetricWindowStartedAtMs = Date.now() - 65000;
  bridge.rpc.emit('notification', {
    method: 'turn/started',
    params: {
      threadId: 'thread-other',
      turn: { id: 'turn-other' },
    },
  });

  const hasSummary = await waitFor(
    () => infoLogs.some((entry) => (
      entry.message === 'non_primary_event_drop_summary'
      && Number(entry.payload?.dropThreadMismatch || 0) >= 1
    )),
    1000,
  );

  assert.equal(hasSummary, true);
});

test('CodexSessionBridge flushes drop summary on stop even before interval elapses', async (t) => {
  class MockRpc extends EventEmitter {
    async start() {}

    async stop() {}

    async request(method) {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-primary' } };
      }
      return {};
    }
  }

  const infoLogs = [];
  const { CodexSessionBridge, restore } = loadBridgeWithMockRpc(MockRpc);
  t.after(restore);

  const bridge = new CodexSessionBridge({
    logger: {
      debug() {},
      warn() {},
      error() {},
      info(message, payload) {
        infoLogs.push({ message, payload });
      },
    },
    codexBin: 'codex',
    codexCwd: process.cwd(),
    mainModel: 'gpt-5.3-codex',
    fastModel: 'gpt-5.3-codex-spark',
    sttProvider: 'none',
  });

  const callbacks = {
    onStatus() {},
    onTranscriptDelta() {},
    onTranscriptFinal() {},
    onMetrics() {},
    onError() {},
  };
  const state = new ClientSessionState('client-4');
  await bridge.start(state, callbacks, {});

  bridge.rpc.emit('notification', {
    method: 'turn/started',
    params: {
      threadId: 'thread-other',
      turn: { id: 'turn-other' },
    },
  });

  await bridge.stop(state, callbacks, { sendStatus: false });

  const hasForcedSummary = infoLogs.some((entry) => (
    entry.message === 'non_primary_event_drop_summary'
    && entry.payload?.reason === 'session_stop'
    && entry.payload?.force === true
    && Number(entry.payload?.dropThreadMismatch || 0) >= 1
  ));
  assert.equal(hasForcedSummary, true);
});

test('CodexSessionBridge records thread resume telemetry on start resume success', async (t) => {
  class MockRpc extends EventEmitter {
    async start() {}

    async stop() {}

    async request(method) {
      if (method === 'thread/resume') {
        return { thread: { id: 'thread-resumed' } };
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thread-started' } };
      }
      return {};
    }
  }

  const { CodexSessionBridge, restore } = loadBridgeWithMockRpc(MockRpc);
  t.after(restore);

  const statusEvents = [];
  const callbacks = {
    onStatus(payload) { statusEvents.push(payload); },
    onTranscriptDelta() {},
    onTranscriptFinal() {},
    onMetrics() {},
    onError() {},
  };

  const bridge = new CodexSessionBridge({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    codexBin: 'codex',
    codexCwd: process.cwd(),
    mainModel: 'gpt-5.3-codex',
    fastModel: 'gpt-5.3-codex-spark',
    sttProvider: 'none',
  });
  const state = new ClientSessionState('client-5');
  await bridge.start(state, callbacks, { resumeThreadId: 'thread-old' });
  t.after(async () => {
    await bridge.stop(state, callbacks, { sendStatus: false });
  });

  assert.equal(state.threadId, 'thread-resumed');
  assert.equal(state.metrics.threadResumeSuccesses, 1);
  assert.equal(state.metrics.threadResumeFailures, 0);
  assert.equal(statusEvents.some((entry) => entry.phase === 'thread_resumed'), true);
});
