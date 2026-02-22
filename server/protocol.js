const { z } = require('zod');

const MAX_PCM_B64_LENGTH = 8192;
const MAX_TEXT_SUBMIT_LENGTH = 4000;

const SessionStartSchema = z.object({
  appVersion: z.string().min(1),
  deviceInfo: z.record(z.string(), z.any()).optional(),
  clientTs: z.number(),
});

const AudioChunkSchema = z.object({
  seq: z.number().int().min(0),
  pcmB64: z.string().min(1).max(MAX_PCM_B64_LENGTH),
  sampleRate: z.literal(16000),
  format: z.literal('pcm16le'),
  durationMs: z.number().int().positive().max(1000),
  byteLength: z.number().int().positive().max(4096),
});

const TextSubmitSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_SUBMIT_LENGTH),
  clientTs: z.number().optional(),
});

const SessionStopSchema = z.object({
  reason: z.string().max(200).optional(),
});

const PingSchema = z.object({
  clientTs: z.number(),
});

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.start'), payload: SessionStartSchema }),
  z.object({ type: z.literal('audio.chunk'), payload: AudioChunkSchema }),
  z.object({ type: z.literal('text.submit'), payload: TextSubmitSchema }),
  z.object({ type: z.literal('session.stop'), payload: SessionStopSchema }),
  z.object({ type: z.literal('ping'), payload: PingSchema }),
]);

const OUTBOUND_TYPES = new Set([
  'status',
  'transcript.delta',
  'transcript.final',
  'metrics',
  'error',
  'pong',
]);

function parseClientMessage(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString('utf8'));
  } catch {
    return {
      ok: false,
      error: 'invalid_json',
      detail: 'Message is not valid JSON',
    };
  }

  const result = ClientMessageSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: 'invalid_message',
      detail: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  return {
    ok: true,
    value: result.data,
  };
}

function makeOutboundMessage(type, payload) {
  if (!OUTBOUND_TYPES.has(type)) {
    throw new Error(`Unsupported outbound message type: ${type}`);
  }

  return JSON.stringify({ type, payload });
}

module.exports = {
  MAX_PCM_B64_LENGTH,
  MAX_TEXT_SUBMIT_LENGTH,
  parseClientMessage,
  makeOutboundMessage,
};
