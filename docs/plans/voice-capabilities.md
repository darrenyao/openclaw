# OpenClaw Voice Capabilities & Voice Broadcast Plan

## Existing Voice Capabilities

### TTS (Text-to-Speech)

- **Providers**: OpenAI (`gpt-4o-mini-tts`, 14 voices), ElevenLabs (multilingual), Edge TTS (free)
- **Auto modes**: `off`, `always`, `inbound`, `tagged`
- **Directives**: `[[tts:provider=openai voice=marin]]`, `[[tts:text]]..[[/tts:text]]`
- **Agent tool**: `tts` tool returns `MEDIA:` path
- **Text summarization**: auto-summarize if > maxTextLength (1500 chars default)
- **Config**: `tts.provider`, `tts.openai.{model,voice}`, `tts.maxTextLength`
- **Key files**: `src/tts/tts.ts`, `src/tts/tts-core.ts`, `src/agents/tools/tts-tool.ts`

### STT (Speech-to-Text)

- **Providers**: OpenAI Whisper (`gpt-4o-mini-transcribe`), Deepgram (nova-3), Groq, Google Cloud, Local Whisper
- **Config**: `tools.media.audio.enabled`
- **Key files**: `src/media-understanding/`

### Voice Call Extension (`extensions/voice-call/`)

- **Telephony providers**: Twilio, Telnyx, Plivo, Mock
- **Call modes**: `conversation` (bidirectional), `notify` (one-way)
- **Streaming STT**: OpenAI Realtime (`gpt-4o-transcribe`) via WebSocket
- **Audio format**: mu-law G.711 8kHz mono (telephony standard)
- **Key files**: `src/manager.ts`, `src/media-stream.ts`, `src/webhook.ts`, `src/response-generator.ts`

### Barge-in (Interrupt) — FULLY IMPLEMENTED

- **Mechanism**: OpenAI Realtime VAD detects speech start → `onSpeechStart()` → `clearTtsQueue()`
- **Implementation**: `extensions/voice-call/src/media-stream.ts` lines 279-310
- **Flow**: VAD detect → abort active TTS (AbortController) → clear queue → clear audio buffer → switch to listening
- **Config**: `streaming.vadThreshold` (0-1, default 0.5), `streaming.silenceDurationMs` (default 800ms)

### Discord Voice (`src/discord/voice/`)

- **Capabilities**: join voice channel, Opus encode/decode, TTS playback, voice messages with waveform
- **Barge-in**: NOT implemented (needs extension)

### Wake Word (`src/infra/voicewake.ts`)

- Default triggers: `["openclaw", "claude", "computer"]`
- Customizable via `voicewake.set` gateway method

## Voice Broadcast + Interrupt Plan

### Recommended: Voice Call (Twilio) — Barge-in Out of Box

**Architecture**:

- Cron triggers → Coordinator Agent generates summary → `voice-call initiate_call mode=conversation`
- TTS streams summary via Twilio Media Streams (WebSocket)
- User interrupts → VAD detects → TTS stops → STT transcribes → Agent responds → TTS replies
- Session key: `voice:{phone_number}`

**Config**:

```json
{
  "plugins": {
    "voice-call": {
      "enabled": true,
      "provider": "twilio",
      "fromNumber": "+1xxx",
      "toNumber": "+86xxx",
      "outbound": { "defaultMode": "conversation" },
      "streaming": {
        "enabled": true,
        "sttProvider": "openai-realtime",
        "silenceDurationMs": 800,
        "vadThreshold": 0.5
      },
      "maxDurationSeconds": 600,
      "maxConcurrentCalls": 2
    }
  },
  "tts": {
    "provider": "openai",
    "openai": { "model": "gpt-4o-mini-tts", "voice": "marin" },
    "maxTextLength": 3000
  }
}
```

**Cron tasks**:

- `voice-morning` (06:30 weekdays): spawn news-scout → summarize → initiate_call conversation
- `urgent-monitor` (\*/15m 8-22): importance >= 5 → voice-call notify

**Webhook setup**: Tailscale Funnel (`tailscale funnel --bg https+insecure://localhost:18789`)

**Cost**: ~$5/month (Twilio number $1.15 + calls ~$1.14 + OpenAI TTS ~$0.75 + Realtime STT ~$1.80)

### Alternative: Discord Voice Channel — Desktop Scenario

- Bot joins voice channel, TTS plays, user speaks to interrupt
- Barge-in needs extension: reuse voice-call's AbortController + VAD pattern on Discord voice events
- Lower latency for desktop users already on Discord

### Alternative: Local WebSocket — Custom Web/Electron App

- Web Audio API + local VAD (Silero) + WebSocket to gateway
- Lowest latency (~100ms LAN), highest dev effort
- Suitable for extreme customization needs

### Interaction Flow Example

```
Jarvis: "早上好，今天有4条要闻。第一条..."
User:   "等等，展开第一条"           → VAD → clearTtsQueue → STT → Agent
Jarvis: "好的，详细内容是..."
User:   "第三条加到任务列表"         → spawn task-manager → confirm
User:   (silence 5s)                → Jarvis: "再见" → hangup
```
