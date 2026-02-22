function uint8ToBase64(uint8) {
  const CHUNK_SIZE = 0x8000;
  let binary = '';

  for (let i = 0; i < uint8.length; i += CHUNK_SIZE) {
    const slice = uint8.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode(...slice);
  }

  return btoa(binary);
}

function computeDurationMs(byteLength, sampleRate) {
  // 16-bit PCM mono: 2 bytes per sample.
  const samples = byteLength / 2;
  const durationMs = (samples / sampleRate) * 1000;
  return Math.max(1, Math.round(durationMs));
}

export class AudioForwarder {
  constructor(options) {
    this.wsClient = options.wsClient;
    this.logger = options.logger;

    this.seq = 0;
    this.framesDropped = 0;
    this.framesSent = 0;
  }

  reset() {
    this.seq = 0;
    this.framesDropped = 0;
    this.framesSent = 0;
  }

  forwardFrame(audioPcm) {
    const frame = audioPcm instanceof Uint8Array ? audioPcm : new Uint8Array(audioPcm);
    const byteLength = frame.byteLength;
    const sampleRate = 16000;

    const payload = {
      seq: this.seq,
      pcmB64: uint8ToBase64(frame),
      sampleRate,
      format: 'pcm16le',
      durationMs: computeDurationMs(byteLength, sampleRate),
      byteLength,
    };

    const sent = this.wsClient.send('audio.chunk', payload);
    this.seq += 1;

    if (!sent) {
      this.framesDropped += 1;
      return false;
    }

    this.framesSent += 1;
    return true;
  }
}
