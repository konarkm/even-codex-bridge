const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSlashCommand } = require('../server/commands');

test('parseSlashCommand parses slash-prefixed restart command', () => {
  const parsed = parseSlashCommand('/restart codex');
  assert.deepEqual(parsed, {
    name: 'restart',
    args: ['codex'],
    raw: '/restart codex',
    supported: true,
  });
});

test('parseSlashCommand parses speech-style slash command', () => {
  const parsed = parseSlashCommand('Slash restart both');
  assert.deepEqual(parsed, {
    name: 'restart',
    args: ['both'],
    raw: 'Slash restart both',
    supported: true,
  });
});

test('parseSlashCommand ignores non-command text', () => {
  const parsed = parseSlashCommand('hello codex');
  assert.equal(parsed, null);
});

test('parseSlashCommand marks unknown commands unsupported', () => {
  const parsed = parseSlashCommand('/status');
  assert.equal(parsed?.name, 'status');
  assert.equal(parsed?.supported, false);
});

test('parseSlashCommand supports thread command', () => {
  const parsed = parseSlashCommand('/thread new');
  assert.deepEqual(parsed, {
    name: 'thread',
    args: ['new'],
    raw: '/thread new',
    supported: true,
  });
});
