const { defineConfig } = require('vite');

module.exports = defineConfig({
  server: {
    allowedHosts: ['codex-even-app.example.com', 'localhost', '127.0.0.1'],
  },
  preview: {
    allowedHosts: ['codex-even-app.example.com', 'localhost', '127.0.0.1'],
  },
});
