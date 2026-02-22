export class WsClient extends EventTarget {
  constructor(options = {}) {
    super();
    this.baseUrl = options.baseUrl || '';
    this.token = options.token || '';
    this.logger = options.logger;

    this.socket = null;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
  }

  setConnectionInfo({ baseUrl, token }) {
    if (baseUrl !== undefined) this.baseUrl = baseUrl;
    if (token !== undefined) this.token = token;
  }

  isOpen() {
    return this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  connect() {
    this.shouldReconnect = true;
    this.#clearReconnectTimer();

    if (!this.baseUrl) {
      this.#emit('error', { message: 'Missing WS base URL' });
      return;
    }

    const wsUrl = this.#buildUrl();
    const protocols = this.#buildProtocols();

    this.#closeActiveSocket();

    this.logger?.info?.(`Connecting WebSocket ${wsUrl}`);
    this.socket = protocols.length > 0 ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);

    this.socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.#emit('open', { url: wsUrl });
    };

    this.socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        this.#emit('error', { message: 'Ignoring non-text websocket frame from server' });
        return;
      }

      try {
        const parsed = JSON.parse(event.data);
        this.#emit('message', parsed);
      } catch {
        this.#emit('error', { message: 'Received invalid JSON from server' });
      }
    };

    this.socket.onerror = () => {
      this.#emit('error', { message: 'WebSocket transport error' });
    };

    this.socket.onclose = (event) => {
      this.#emit('close', {
        code: event.code,
        reason: event.reason,
      });

      if (!this.shouldReconnect) return;
      if (this.#isTerminalClose(event)) {
        this.shouldReconnect = false;
        this.#emit('error', {
          message: `WebSocket closed without reconnect (${event.code}${event.reason ? `: ${event.reason}` : ''})`,
        });
        return;
      }
      this.#scheduleReconnect();
    };
  }

  disconnect() {
    this.shouldReconnect = false;
    this.#clearReconnectTimer();
    this.#closeActiveSocket();
  }

  send(type, payload) {
    if (!this.isOpen()) return false;

    this.socket.send(
      JSON.stringify({
        type,
        payload,
      }),
    );

    return true;
  }

  #buildUrl() {
    const raw = this.baseUrl.trim();
    const normalized = raw.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
    const url = new URL(normalized);
    return url.toString();
  }

  #buildProtocols() {
    const protocols = ['ambient-v1'];
    const encoded = this.#encodeTokenForProtocol(this.token);
    if (encoded) {
      protocols.push(`ambient-auth.${encoded}`);
    }
    return protocols;
  }

  #encodeTokenForProtocol(token) {
    const value = String(token || '').trim();
    if (!value) return '';

    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  #isTerminalClose(event) {
    if (!event) return false;
    if (event.code === 1008) return true;
    const reason = String(event.reason || '').toLowerCase();
    return reason === 'unauthorized' || reason === 'origin_not_allowed';
  }

  #scheduleReconnect() {
    this.reconnectAttempt += 1;
    const backoffMs = Math.min(15000, 500 * 2 ** (this.reconnectAttempt - 1));
    const jitter = Math.floor(Math.random() * 250);
    const delay = backoffMs + jitter;

    this.#emit('reconnecting', {
      attempt: this.reconnectAttempt,
      delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  #clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  #closeActiveSocket() {
    if (!this.socket) return;

    this.socket.onopen = null;
    this.socket.onmessage = null;
    this.socket.onerror = null;
    this.socket.onclose = null;

    try {
      this.socket.close();
    } catch {
      // No-op.
    }

    this.socket = null;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
