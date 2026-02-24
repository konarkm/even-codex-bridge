const SUPPORTED_COMMANDS = new Set(['restart', 'thread']);

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

  const [nameRaw = '', ...args] = commandBody.split(/\s+/).filter(Boolean);
  const name = nameRaw.toLowerCase();
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
