const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

class CodexRpcClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.child = null;
    this.stdoutBuffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.started = false;
    this.childGeneration = 0;
  }

  async start() {
    if (this.started) return;

    const child = spawn(this.options.codexBin || 'codex', ['app-server'], {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const generation = ++this.childGeneration;
    this.child = child;
    this.stdoutBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      if (!this.#isCurrentChild(child, generation)) return;
      this.#handleStdout(chunk);
    });

    child.stderr.on('data', (chunk) => {
      if (!this.#isCurrentChild(child, generation)) return;
      this.emit('stderr', String(chunk));
    });

    child.on('exit', (code, signal) => {
      if (!this.#isCurrentChild(child, generation)) return;
      this.started = false;
      this.child = null;
      this.#rejectPending(new Error(`codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
      this.emit('exit', { code, signal });
    });

    child.on('error', (error) => {
      if (!this.#isCurrentChild(child, generation)) return;
      this.started = false;
      this.child = null;
      this.#rejectPending(error);
      this.emit('error', error);
    });

    this.started = true;

    await this.request('initialize', {
      clientInfo: {
        name: this.options.clientName || 'even_codex_bridge',
        title: this.options.clientTitle || 'Even Codex Bridge',
        version: this.options.clientVersion || '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    await this.notify('initialized', {});
  }

  async stop() {
    this.started = false;
    if (!this.child) return;

    const child = this.child;
    this.child = null;
    this.#rejectPending(new Error('codex app-server stopped'));

    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore kill errors.
    }
  }

  async request(method, params, timeoutMs = 120000) {
    this.#ensureStarted();
    const id = this.nextId++;

    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });
    });

    this.#writeMessage(request);
    return resultPromise;
  }

  async notify(method, params) {
    this.#ensureStarted();
    this.#writeMessage({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  async respond(id, result) {
    this.#ensureStarted();
    this.#writeMessage({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  async respondError(id, code, message, data) {
    this.#ensureStarted();
    this.#writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    });
  }

  #ensureStarted() {
    if (!this.started || !this.child || !this.child.stdin.writable) {
      throw new Error('codex app-server is not started');
    }
  }

  #writeMessage(message) {
    if (!this.child) {
      throw new Error('codex child missing');
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleStdout(chunk) {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (!line) continue;
      this.#handleLine(line);
    }
  }

  #handleLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.emit('error', new Error(`Invalid JSON from codex app-server: ${String(error)}`));
      return;
    }

    if (Object.prototype.hasOwnProperty.call(parsed, 'id')) {
      if (Object.prototype.hasOwnProperty.call(parsed, 'method')) {
        this.emit('serverRequest', {
          id: parsed.id,
          method: parsed.method,
          params: parsed.params,
        });
        return;
      }

      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);

      if (parsed.error) {
        pending.reject(new Error(this.#formatRpcError(parsed.error)));
        return;
      }

      pending.resolve(parsed.result);
      return;
    }

    if (parsed.method) {
      this.emit('notification', {
        method: parsed.method,
        params: parsed.params,
      });
    }
  }

  #formatRpcError(error) {
    if (!error) return 'Unknown RPC error';
    const message = error.message || 'Unknown RPC error';
    const code = error.code != null ? ` (code=${error.code})` : '';
    return `${message}${code}`;
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #isCurrentChild(child, generation) {
    return this.child === child && this.childGeneration === generation;
  }
}

module.exports = {
  CodexRpcClient,
};
