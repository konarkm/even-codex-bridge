const { defineConfig, loadEnv } = require('vite');

function parseAllowedHostsFromEnv(env) {
  const raw = [env.VITE_ALLOWED_HOSTS, env.ALLOWED_ORIGINS]
    .filter(Boolean)
    .join(',');
  if (!raw) return [];

  const items = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  const hosts = [];
  for (const item of items) {
    if (item.includes('://')) {
      try {
        hosts.push(new URL(item).hostname);
      } catch (_) {
        // Ignore malformed entries and continue with remaining values.
      }
      continue;
    }
    hosts.push(item);
  }
  return hosts;
}

module.exports = defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const allowedHosts = Array.from(new Set([
    'codex-even-app.example.com',
    'localhost',
    '127.0.0.1',
    ...parseAllowedHostsFromEnv(env),
  ]));

  return {
    server: {
      allowedHosts,
    },
    preview: {
      allowedHosts,
    },
  };
});
