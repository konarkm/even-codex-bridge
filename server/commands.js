const SUPPORTED_COMMANDS = new Set([
  'help',
  'status',
  'stop',
  'reset',
  'debug',
  'thread',
  'compact',
  'effort',
  'spark',
  'fast',
  'restart',
]);

function normalizeCommandToken(token, options = {}) {
  const trimmed = String(token || '').trim();
  if (!trimmed) return '';

  const unquoted = trimmed.replace(/^[`"']+|[`"']+$/g, '');
  const withoutTrailingPunctuation = unquoted.replace(/[.,!?;:]+$/g, '');
  const normalized = withoutTrailingPunctuation.trim();
  if (!normalized) return '';

  return options.lowercase ? normalized.toLowerCase() : normalized;
}

function parseSlashCommand(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let commandBody = null;
  if (raw.startsWith('/')) {
    commandBody = raw.slice(1).trim();
  } else {
    const slashPrefix = raw.match(/^slash\b[:\s-]*/i);
    if (slashPrefix) {
      commandBody = raw.slice(slashPrefix[0].length).trim();
    }
  }

  if (!commandBody) {
    return null;
  }

  const [nameRaw = '', ...argsRaw] = commandBody.split(/\s+/).filter(Boolean);
  const name = normalizeCommandToken(nameRaw, { lowercase: true });
  const args = argsRaw
    .map((token) => normalizeCommandToken(token))
    .filter(Boolean);
  if (!name) {
    return null;
  }

  return {
    name,
    args,
    raw,
    supported: SUPPORTED_COMMANDS.has(name),
  };
}

module.exports = {
  parseSlashCommand,
};
