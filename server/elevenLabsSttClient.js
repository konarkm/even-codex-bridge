const WebSocket = require('ws');

class ElevenLabsSttClient {
  constructor(options) {
    this.apiKey = options.apiKey;
    this.modelId = options.modelId || 'scribe_v2_realtime';
    this.language = options.language || 'en';
    this.commitStrategy = options.commitStrategy || 'vad';
    this.logger = options.logger;
    this.onPartial = options.onPartial;
    this.onFinal = options.onFinal;
    this.onError = options.onError;
    this.onStatus = options.onStatus;

    this.socket = null;
    this.ready = false;
    this.lastPartialText = '';
    this.connectingPromise = null;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.stopped = true;
    this.lastAudioSentAt = 0;
    this.keepaliveChunk = Buffer.alloc(640); // 20ms silence at 16kHz PCM16.
  }

  async start() {
    if (!this.apiKey) {
      throw new Error('Missing STT_API_KEY for ElevenLabs STT');
    }

    this.stopped = false;
    await this.#ensureConnected();
  }

  stop() {
    this.stopped = true;
    this.ready = false;
    this.lastPartialText = '';
    this.connectingPromise = null;
    this.#clearKeepalive();
    this.#clearReconnect();

    if (!this.socket) return;

    const socket = this.socket;
    this.socket = null;
    try {
      socket.close();
    } catch {
      // Ignore close errors.
    }
  }

  sendAudio(audioBuffer) {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.#scheduleReconnect(0, 'audio_not_ready');
      return false;
    }

    try {
      this.socket.send(
        JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: Buffer.from(audioBuffer).toString('base64'),
          sample_rate: 16000,
        }),
      );
      this.lastAudioSentAt = Date.now();
      return true;
    } catch (error) {
      this.onError?.(error);
      return false;
    }
  }

  async #ensureConnected() {
    if (this.stopped) return;
    if (this.ready && this.socket && this.socket.readyState === WebSocket.OPEN) return;
    if (this.connectingPromise) return this.connectingPromise;

    const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    url.searchParams.set('model_id', this.modelId);
    url.searchParams.set('language_code', this.language);
    url.searchParams.set('audio_format', 'pcm_16000');
    url.searchParams.set('commit_strategy', this.commitStrategy);
    url.searchParams.set('include_timestamps', 'false');

    const socket = new WebSocket(url.toString(), {
      headers: {
        'xi-api-key': this.apiKey,
      },
    });

    this.socket = socket;
    this.connectingPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out connecting to ElevenLabs realtime STT'));
      }, 10000);

      socket.once('open', () => {
        clearTimeout(timeout);
        this.ready = true;
        this.reconnectAttempt = 0;
        this.lastAudioSentAt = Date.now();
        this.#startKeepalive();
        this.onStatus?.('stt_connected', `ElevenLabs STT connected (${this.modelId})`);
        resolve();
      });

      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    socket.on('message', (data) => {
      this.#handleMessage(data);
    });

    socket.on('error', (error) => {
      this.onError?.(error);
    });

    socket.on('close', (code, reasonBuffer) => {
      const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString('utf8') : String(reasonBuffer || '');
      const wasReady = this.ready;
      this.ready = false;
      this.#clearKeepalive();
      if (this.socket === socket) {
        this.socket = null;
      }

      if (wasReady) {
        const suffix = reason ? ` (code=${code}, reason=${reason})` : ` (code=${code})`;
        this.onStatus?.('stt_disconnected', `ElevenLabs STT disconnected${suffix}`);
      }

      if (!this.stopped) {
        this.#scheduleReconnect(undefined, 'socket_close');
      }
    });

    try {
      await this.connectingPromise;
    } catch (error) {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.ready = false;
      if (!this.stopped) {
        this.#scheduleReconnect(undefined, 'connect_error');
      }
      throw error;
    } finally {
      this.connectingPromise = null;
    }
  }

  #startKeepalive() {
    this.#clearKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.stopped || !this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastAudioSentAt < 5000) return;

      try {
        this.socket.send(
          JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: this.keepaliveChunk.toString('base64'),
            sample_rate: 16000,
          }),
        );
        this.lastAudioSentAt = Date.now();
      } catch (error) {
        this.onError?.(error);
      }
    }, 5000);
  }

  #clearKeepalive() {
    if (!this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  #scheduleReconnect(delayMs, source) {
    if (this.stopped) return;
    if (this.ready) return;
    if (this.connectingPromise) return;
    if (this.reconnectTimer) return;

    const delay =
      typeof delayMs === 'number'
        ? Math.max(0, delayMs)
        : Math.min(5000, 400 * Math.pow(2, Math.min(this.reconnectAttempt, 5)));
    this.reconnectAttempt += 1;
    this.onStatus?.('stt_reconnecting', `Reconnecting STT in ${Math.ceil(delay / 1000)}s (${source || 'retry'})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#ensureConnected().catch((error) => {
        this.onError?.(error);
      });
    }, delay);
  }

  #clearReconnect() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  #handleMessage(data) {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch {
      return;
    }

    const type = String(parsed?.message_type || '').toLowerCase();
    const text = String(parsed?.text || '').trim();

    if (type === 'session_started') {
      this.onStatus?.('stt_session_started', 'STT session started');
      return;
    }

    if (type === 'partial_transcript') {
      if (!text) return;
      if (text === this.lastPartialText) return;
      this.lastPartialText = text;
      this.onPartial?.(text);
      return;
    }

    if (type === 'committed_transcript' || type === 'committed_transcript_with_timestamps') {
      if (!text) return;
      this.lastPartialText = '';
      this.onFinal?.(text);
      return;
    }

    if (type.includes('error')) {
      const message = parsed?.error || parsed?.message || parsed?.detail || `ElevenLabs STT error: ${type}`;
      this.onError?.(new Error(String(message)));
    }
  }
}

module.exports = {
  ElevenLabsSttClient,
};
