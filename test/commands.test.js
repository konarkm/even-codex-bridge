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

test('parseSlashCommand supports status command', () => {
  const parsed = parseSlashCommand('/status');
  assert.equal(parsed?.name, 'status');
  assert.equal(parsed?.supported, true);
});

test('parseSlashCommand marks unsupported commands', () => {
  const parsed = parseSlashCommand('/notifications');
  assert.equal(parsed?.name, 'notifications');
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

test('parseSlashCommand handles trailing punctuation in command name', () => {
  const parsed = parseSlashCommand('slash status.');
  assert.deepEqual(parsed, {
    name: 'status',
    args: [],
    raw: 'slash status.',
    supported: true,
  });
});

test('parseSlashCommand handles trailing punctuation in arguments', () => {
  const parsed = parseSlashCommand('/restart codex.');
  assert.deepEqual(parsed, {
    name: 'restart',
    args: ['codex'],
    raw: '/restart codex.',
    supported: true,
  });
});

test('parseSlashCommand strips punctuation from thread action', () => {
  const parsed = parseSlashCommand('/thread new!');
  assert.deepEqual(parsed, {
    name: 'thread',
    args: ['new'],
    raw: '/thread new!',
    supported: true,
  });
});
