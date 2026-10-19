# Voice and audio

Agents hear audio: attach a voice note or a recording to a message, and the
runtime transcribes it before the model sees it, so every model, Claude
included, reads what was said. `POST /v1/transcriptions` transcribes audio on
its own, with no agent.

Transcription runs on OpenAI's `gpt-transcribe` (its recommended model for recorded speech) with the
OpenAI key a model call of yours would use: a [key scope](models-and-keys.md#key-scopes)'s, your own
(`PUT /v1/providers/openai/key`), else the platform's, which a prepaid account pays for per second of
audio (see [Pricing](../pricing.md)).

## Audio in a message

Attach audio as any file. A file whose type is `audio/*` is transcribed by
default:

```ts
const run = await agent.run("Summarize this and list the action items", { files: ["./standup.m4a"] });
```

```python
run = await agent.run("Summarize this and list the action items", files=[Path("standup.m4a")])
```

A voice note alone needs no text: `agent.run("", { files: [voiceNote] })`. In the SDKs a file is also
`{ url }` (Python `{"url"}`), and takes `transcribe: true | false`.

```bash
curl -X POST "$RUNTIME/v1/agents/$AGENT/prompt" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"files": [{"url": "https://example.com/voice-message.ogg"}]}'
```

A file is attached as [Files](files.md#attaching-files-to-a-message) describes (uploaded, inline base64 up
to 4 MiB, or `{path}` of a file in the agent's mounts), or by URL: `{url, name?, contentType?}`, which the
runtime fetches from the public internet (at most 64 MiB, three redirects). `text` may be left out when the
message has audio.

The runtime transcribes the audio **before it accepts the message**: the prompt's answer comes once the
transcript is ready (a second or two for a voice note, longer for a long recording), and a transcription that
fails fails the request, with nothing run. The message, its events and the agent's history keep the audio
file's reference with its transcript:

```json
{ "type": "file", "path": "/workspace/uploads/r1/voice-message.ogg", "contentType": "audio/ogg", "size": 12538,
  "transcript": { "text": "Hello from camelRun.", "language": "en", "seconds": 5, "model": "gpt-transcribe" }, ... }
```

and the model reads it as text:

```
[Audio /workspace/uploads/r1/voice-message.ogg (audio/ogg, 0:05, en), transcript:
Hello from camelRun.
]
```

The audio stays in the agent's workspace like any attachment, for its tools to use.

- `transcribe: false` on a file keeps audio a plain file (named to the model, not transcribed).
- `transcribe: true` transcribes a file whose type does not say audio (`application/octet-stream`, or a
  video such as `video/mp4` or `video/webm`, whose sound is transcribed).
- Audio transcribed by default that cannot be (no OpenAI key, a format or length it does not take, the
  provider failing) is attached without a transcript, and the model is told why
  (`[File …: not transcribed (…)]`), so a voice note from a [channel](channels.md) still reaches the agent.
  A file you asked to transcribe (`transcribe: true`) fails the request instead.
- A spend limit refuses the request either way: the agent's, or the run's own `spendLimit`, which pays for
  the message's audio first (what is left is the run's to spend on its model).

[Channels](channels.md) get this with no setup: a Discord or Telegram voice message, or any audio file sent in
a channel, reaches the agent with its transcript. [Stateless runs](stateless-runs.md)
take audio as input parts: `{"type": "file", "url": "…"}` or `{"type": "file", "data": "…"}`.

## Transcribing on its own

```ts
const { text } = await agents.transcriptions.create({ file: await readFile("voice-message.ogg"), language: "en" });
```

```python
result = await agents.transcriptions.create(Path("voice-message.ogg"), language="en")
```

```bash
curl -X POST "$RUNTIME/v1/transcriptions" -H "Authorization: Bearer $TOKEN" -F file=@voice-message.ogg -F language=en
```

```json
{ "text": "Hello from camelRun.", "language": "en", "durationSeconds": 5, "model": "openai/gpt-transcribe", "costUsd": 0.000375 }
```

It takes the audio as multipart (`file`) or JSON: `{"data": "<base64>"}` or `{"url": "https://…"}`. With
either:

| Field | |
| --- | --- |
| `language` | ISO 639-1 (`en`) or a locale (`pt-BR`); detected when left out |
| `prompt` | names, jargon or the conversation so far, as a hint (at most 2,000 characters) |
| `keyScope` | a key scope whose OpenAI key goes first |
| `subject`, `context`, `actor` | who it is for and who asked, carried to its `usage.recorded` event, as an agent's identity is |

Nothing is kept: the audio goes to the provider and the transcript comes back to you. A retry transcribes (and
bills) again; it takes no `Idempotency-Key`. API tokens and OAuth tokens may transcribe; browser tokens may not.
Runs-per-minute limits count each transcription as a run.

## Speech on its own

`POST /v1/speech` turns text into speech and streams the audio back as it is made:

```sh
curl -sS https://run.camelai.com/v1/speech -H "Authorization: Bearer $CAMELRUN_API_KEY" -H "Content-Type: application/json" \
  -d '{"text": "Hi, I am your bot.", "voice": "coral", "format": "wav"}' -o hello.wav
```

`format` is `pcm` (the default: raw 16-bit little-endian mono at 24 kHz) or `wav` (the same in a WAV container, which
an `<audio>` element plays as it downloads). The text is at most 4,000 characters; `instructions` (at most 1,000) says
how to say it (tone, pace, accent) to OpenAI; `language` tells providers that speak many languages which one to
pronounce; `keyScope`, `subject`, `context`, `actor` and `bucket` mean what they do for a transcription.

By default speech is made with OpenAI's `gpt-4o-mini-tts` in `voice` (`alloy`, `coral`, `verse`…), on your OpenAI key
or the platform's: without one it is a 400 (`SPEECH_UNAVAILABLE`), and text OpenAI refuses is a 400 too. `speech:
{providers, voices}` names providers to try in order instead, each `<provider>` (its default model) or
`<provider>/<model>`, on your key for it (`PUT /v1/providers/<provider>/key`, or a key scope's), else the platform's; one
with no key is skipped. Without `providers`, `voices` that name a provider other than OpenAI choose them: those
providers in the order given, then OpenAI (`{"voices": {"elevenlabs": "…", "openai": "coral"}}` speaks with ElevenLabs):

| Provider | Default model | Voice (`speech.voices.<provider>`) |
| --- | --- | --- |
| `elevenlabs` | `eleven_flash_v2_5` (its fastest) | An ElevenLabs voice id. Default: the premade "Rachel" |
| `cartesia` | `sonic-3` | A Cartesia voice id. Required: Cartesia is skipped without one |
| `deepgram` | `aura-2` | An Aura voice. Default: `aura-2-thalia-en` |
| `openai` | `gpt-4o-mini-tts` | `voice` (alloy, coral, verse…). Takes `instructions` |

A provider that fails, or that sends no audible audio within 3 s, is passed over for the next one; once audio has gone
out, a failure ends the stream. `X-Speech-Model` names the provider and model that served.

It is billed as its provider bills it: OpenAI's per second of speech made ($0.015 a minute on the platform's key),
ElevenLabs, Cartesia and Deepgram Aura per character of the text, at their list prices. Each is a `usage.recorded` with
`kind: "speech"` and `audioSeconds`, against an end user's credit when you name a `subject` (held before it is made). A
caller that hangs up stops it; what was made is billed. Nothing is kept: neither the text nor the audio.

## Formats and limits

| | |
| --- | --- |
| Formats | Ogg (Opus or Vorbis: Discord, Telegram and WhatsApp voice notes), WebM (browsers' `MediaRecorder`), MP3, M4A/MP4 (AAC), WAV, FLAC |
| One audio file | 25 MB and 30 minutes |
| One message | 5 audio files, 30 minutes in all |

The runtime reads a file's length from its container before sending it, so its cost is known first: audio
whose container gives no length (an Ogg stream cut short) is refused (415, `UNSUPPORTED_AUDIO`), as are
other formats (AIFF, CAF, AMR: convert them, e.g. `ffmpeg -i in.aiff out.flac`). Too large or too long is 413
(`AUDIO_TOO_LARGE`, `AUDIO_TOO_LONG`). A provider failure is 502 (`TRANSCRIPTION_FAILED`); audio the provider
refuses, 400.

## Billing

On the platform's key, a transcription costs $0.0045 a minute of audio (`gpt-transcribe`'s price), per second as
the provider bills it. On your own key or a
key scope's, OpenAI bills you and camelRun charges nothing. Either way it is recorded:

- in `GET /v1/usage`, a row per day with `kind: "transcription"` and model `openai/gpt-transcribe` (`responses` counts transcriptions);
- in the hour's ledger entry, as `transcription` (micro-USD), `transcriptions` and `audioSeconds`;
- as a [`usage.recorded`](webhooks.md) event with `kind: "transcription"`, `audioSeconds` and no tokens. In a
  message it carries the run's `requestId`, `actor`, the agent's identity and key scope; on its own,
  `agentId: null` and the `subject`, `context` and `actor` you sent. The older usage webhook
  (`/v1/usage-webhook`) carries model responses only.

It counts toward an agent's spend limit, a run's own spend limit, a tenant's monthly cap and prepaid credit,
as a model response does.

## Privacy

Audio and transcripts are never written to the runtime's logs, which carry sizes, lengths, the model and error
classes. An attached file and its transcript are kept with the agent's history and workspace, and deleted with
them; a standalone transcription keeps nothing. OpenAI processes the audio under its API data policy (not used
for training). See [Account data](../operations/privacy.md#transcription).

## Not yet

- **Audio to the model itself.** Every model reads the transcript today; models that hear audio natively may be
  given the sound later, beside it.
- **Timestamps or speaker labels.** Transcripts are text only, from the one model.
- **Live voice outside calls.** Live speech is offered in Discord voice calls: camelRun sits in a call for your bot, and
  a realtime speech-to-speech model answers aloud. See [Voice calls](voice-calls.md). Speech out on its own is
  `POST /v1/speech` (above).
- **Audio in `initialMessages`.** Transcribe it first with `POST /v1/transcriptions` and import the text.

## Find a character voice

`GET /v1/voices/search?provider=elevenlabs&q=cat&category=professional&limit=10`
uses your tenant token, as the other `/v1` endpoints do. `provider` is required;
`q` defaults to an empty search, `limit` is 1–30 (default 10), and `category` is
optional (`professional`, `famous`, or `high_quality`). Every call fetches fresh
metadata; responses use `Cache-Control: no-store` and the normal API request rate limit applies.

```ts
const { voices } = await agents.voices.search({ provider: "elevenlabs", q: "cat", limit: 10 });
```

```python
result = await agents.voices.search(provider="elevenlabs", q="cat", limit=10)
# Synchronous SDK: result = agents.voices.search(provider="elevenlabs", q="cat", limit=10)
```

Both SDKs also expose `runtime.voices.search`. The response is `{ voices: [...] }`.
Each voice has `provider`, `id`, `name`, `description`, `labels` (available
`accent`, `age`, `gender`, `use_case`), `previewUrl`, and `category`. Missing
metadata is `null`, missing labels are omitted. Save `id` as the session's
`realtime.voice` with an ElevenLabs realtime model. Search also accepts
`provider=grok|openai|gemini`, returning the runtime's fixed voice definitions
filtered by `q` without a provider key; library categories match none of these.

ElevenLabs search uses the same credential resolution as speech: your saved
ElevenLabs key, the tenant file's key, else `platformKeys.elevenlabs` where your
account can use platform keys. Existing platform credit checks apply. There is
no new configuration. Keys and upstream error bodies are never returned or logged.
A missing key returns `400 VOICE_SEARCH_UNAVAILABLE`; an upstream failure returns
`502 VOICE_SEARCH_FAILED`.

The upstream [shared voice library API](https://elevenlabs.io/docs/api-reference/voices/voice-library/get-shared)
receives `search`, `category` when supplied, and `page_size`. This implements the
server-side discovery described in [camel-bots' authoring guide](https://github.com/qaml-ai/camel-bots/blob/main/docs/guides.md).

[Agents overrides](https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides)
select a voice but do not document granting account access to an unadded shared
voice. The realtime provider therefore checks the account's
[available voices](https://elevenlabs.io/docs/api-reference/voices/search) before
opening a conversation. If the exact ID is missing, it finds that ID's public
owner in the library and [adds the shared voice](https://elevenlabs.io/docs/api-reference/voices/voice-library/share),
using the returned account voice ID for the override. Concurrent starts on one
node share only the in-flight check/add; later starts recheck the account, so an
already-added voice is not added again. An add failure is accepted only when a
fresh account lookup confirms another request added it. Search itself never adds
voices. The ElevenLabs account must allow library API access and have permission
to add voices; this behavior has mocked coverage and needs a live account check
before rollout.
