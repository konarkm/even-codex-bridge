const test = require('node:test');
const assert = require('node:assert/strict');

const { parseClientMessage, makeOutboundMessage } = require('../server/protocol');

test('parseClientMessage accepts valid text.submit payload', () => {
  const parsed = parseClientMessage(
    JSON.stringify({
      type: 'text.submit',
      payload: {
        text: 'hello codex',
        clientTs: Date.now(),
      },
    }),
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.type, 'text.submit');
});

test('parseClientMessage rejects malformed audio payload', () => {
  const parsed = parseClientMessage(
    JSON.stringify({
      type: 'audio.chunk',
      payload: {
        seq: 0,
        pcmB64: 'AA==',
        sampleRate: 8000,
        format: 'pcm16le',
        durationMs: 10,
        byteLength: 1,
      },
    }),
  );

  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'invalid_message');
});

test('makeOutboundMessage only allows known outbound types', () => {
  const encoded = makeOutboundMessage('status', { phase: 'running' });
  const parsed = JSON.parse(encoded);

  assert.equal(parsed.type, 'status');
  assert.deepEqual(parsed.payload, { phase: 'running' });

  assert.throws(() => makeOutboundMessage('unknown', {}));
});
