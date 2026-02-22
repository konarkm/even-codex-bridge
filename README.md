# even-codex-bridge

Text-first bridge to use Codex from Even G2 glasses.

## Current scope
- Even web app captures mic PCM frames and forwards to backend.
- Backend streams PCM to ElevenLabs Scribe v2 Realtime STT.
- Final STT text (or manual text submission) is sent to `codex app-server`.
- Codex deltas/finals are rendered back on glasses.

## Runtime mode
This repo is configured for YOLO mode:
- `approvalPolicy: "never"`
- `sandboxPolicy: { type: "dangerFullAccess" }`

## Repo layout
- `server/index.js`: websocket bridge entrypoint
- `server/codexRpcClient.js`: JSON-RPC stdio client for `codex app-server`
- `server/codexSessionBridge.js`: thread/turn orchestration + notification mapping
- `server/elevenLabsSttClient.js`: realtime STT client for ElevenLabs
- `server/protocol.js`: frontend/backend message validation
- `src/`: Even web app frontend

## Prerequisites
- Node 20+
- `codex` CLI installed and available in PATH (or set `CODEX_BIN`)
- Even beta app + Even Hub dev mode
- ElevenLabs API key with realtime speech-to-text access

## Configure
1. Copy `.env.example` to `.env`.
2. Set at minimum:
- `CLIENT_SHARED_TOKEN`
- `VITE_CLIENT_SHARED_TOKEN` (must match exactly)
- `CODEX_CWD`
- `VITE_WS_BASE_URL`
3. STT configuration:
- `STT_PROVIDER=elevenlabs`
- `STT_API_KEY=<your key>`
- `STT_MODEL_ID=scribe_v2_realtime`
- `STT_COMMIT_STRATEGY=vad`

For text-only mode without mic STT, set `STT_PROVIDER=none` and use manual text submit.

## Run
Terminal A:
```bash
npm run dev:server
```

Terminal B:
```bash
npm run dev:client
```

Or both:
```bash
npm run dev
```

### Optional simulator autostart (dev-only)
For simulator/automation loops, you can boot directly into the running assistant:
- Query flag: `?autostart=1`
- Env flag: `VITE_AUTO_START=1`
- Optional query overrides (for ephemeral test sessions): `?ws=<wss-url>&token=<shared-token>&autostart=1`

Example:
`https://codex-even-app.example.com/?autostart=1`

## Cloudflared tunnel
One-time setup for a named tunnel + DNS routes:
```bash
cloudflared tunnel create codex-even
cloudflared tunnel route dns codex-even codex-even-app.example.com
cloudflared tunnel route dns codex-even codex-even-api.example.com
```

Run the dual-host tunnel (frontend + backend):
```bash
npm run tunnel
```

Run tunnel and provision DNS in the same step:
```bash
npm run tunnel -- --provision-dns
```

Run a temporary quick tunnel instead:
```bash
npm run tunnel:quick
```

Set matching env values:
- `VITE_WS_BASE_URL=wss://codex-even-api.example.com/ws`
- `ALLOWED_ORIGINS=https://codex-even-app.example.com,http://localhost:5173,http://127.0.0.1:5173`

By default the script runs tunnel `codex-even`.
The script resolves the tunnel UUID and uses that for route/run calls (avoids name-resolution fallback to default tunnel config).

## Protocol
Client -> server:
- `session.start`: `{ appVersion, deviceInfo?, clientTs }`
- `audio.chunk`: `{ seq, pcmB64, sampleRate:16000, format:"pcm16le", durationMs, byteLength }`
- `text.submit`: `{ text, clientTs? }`
- `session.stop`: `{ reason? }`
- `ping`: `{ clientTs }`

Server -> client:
- `status`: `{ phase, detail?, sessionId? }`
- `transcript.delta`: `{ text, turnId, role, replace?, ts }`
- `transcript.final`: `{ text, turnId, role, ts }`
- `metrics`: runtime counters
- `error`: `{ code, message, recoverable }`
- `pong`: `{ serverTs, clientTs? }`

## UI behavior
- `text.submit` (manual prompt box) remains a permanent dev/QA path.
- Single click (`CLICK_EVENT`) toggles mic state:
  - `listening` = mic on and STT ingest active.
  - `muted` = mic off (`audioControl(false)`), STT ingest paused.
- Double click (`DOUBLE_CLICK_EVENT`) toggles focus mode:
  - Focus mode shows assistant output + compact status (`listening|muted` + connection state).
  - Normal mode keeps richer transcript/status context.
- Ring scroll is inverted from the prior behavior in this app.
  - Scroll events page the assistant final-output window.
- Auto-mute safety policy:
  - Triggers on backend disconnect/reconnect only.
  - Auto-resume only occurs when mute reason is `auto` and backend connectivity recovers.
  - Manual mute is never auto-resumed.

## Notes
- Codex websocket transport is intentionally not used here; this bridge uses stdio app-server transport.
- `src/evenBridge.js` includes SDK-safe startup fallback for `createStartUpPageContainer` one-time behavior.
