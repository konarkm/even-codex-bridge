const test = require('node:test');
const assert = require('node:assert/strict');

const { ClientSessionState } = require('../server/sessionState');

test('ClientSessionState tracks running lifecycle', () => {
  const state = new ClientSessionState('client-1');

  assert.equal(state.running, false);
  state.markRunning('thread-1');
  assert.equal(state.running, true);
  assert.equal(state.threadId, 'thread-1');

  state.setActiveTurn('turn-1');
  assert.equal(state.activeTurnId, 'turn-1');

  state.markStopped();
  assert.equal(state.running, false);
  assert.equal(state.threadId, null);
  assert.equal(state.activeTurnId, null);
});

test('ClientSessionState resetMetrics clears counters', () => {
  const state = new ClientSessionState('client-2');

  state.metrics.framesReceived = 10;
  state.metrics.framesDropped = 3;
  state.metrics.sttFinals = 2;
  state.metrics.turnsStarted = 4;

  state.resetMetrics();

  assert.equal(state.metrics.framesReceived, 0);
  assert.equal(state.metrics.framesDropped, 0);
  assert.equal(state.metrics.sttFinals, 0);
  assert.equal(state.metrics.turnsStarted, 0);
});
