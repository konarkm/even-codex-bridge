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
  }

  async start() {
    if (!this.apiKey) {
      throw new Error('Missing STT_API_KEY for ElevenLabs STT');
    }

    if (this.socket) return;

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

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out connecting to ElevenLabs realtime STT'));
      }, 10000);

      socket.once('open', () => {
        clearTimeout(timeout);
        this.ready = true;
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

    socket.on('close', () => {
      this.ready = false;
      this.onStatus?.('stt_disconnected', 'ElevenLabs STT disconnected');
    });
  }

  stop() {
    this.ready = false;
    this.lastPartialText = '';

    if (!this.socket) return;

    try {
      this.socket.close();
    } catch {
      // Ignore close errors.
    }

    this.socket = null;
  }

  sendAudio(audioBuffer) {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
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
      return true;
    } catch (error) {
      this.onError?.(error);
      return false;
    }
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
