const LEVEL_ORDER = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function normalizeLevel(raw) {
  const level = String(raw || '').toLowerCase();
  return LEVEL_ORDER[level] !== undefined ? level : 'info';
}

function createLogger(scope = 'app') {
  const configuredLevel = normalizeLevel(process.env.LOG_LEVEL || 'info');

  function shouldLog(level) {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[configuredLevel];
  }

  function emit(level, message, meta = {}) {
    if (!shouldLog(level)) return;

    const record = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg: message,
      ...meta,
    };

    const output = JSON.stringify(record);
    if (level === 'error') {
      console.error(output);
      return;
    }
    if (level === 'warn') {
      console.warn(output);
      return;
    }
    console.log(output);
  }

  return {
    error: (message, meta) => emit('error', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    info: (message, meta) => emit('info', message, meta),
    debug: (message, meta) => emit('debug', message, meta),
  };
}

module.exports = {
  createLogger,
};
