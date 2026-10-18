# Voice calls

camelRun can sit in a Discord voice call for your bot and listen: it cuts each person's speech into utterances,
transcribes them, and sends the text to your webhooks or to an agent. Your app keeps its Discord gateway and its bot
token; camelRun never sees either.

Joining a voice channel is the only step that needs the bot's gateway. Your app asks to join (OP 4, voice state
update), and Discord answers on the gateway with two dispatches: the bot's `VOICE_STATE_UPDATE` (its voice
`session_id`) and the guild's `VOICE_SERVER_UPDATE` (a voice server `endpoint` and a `token`). With those, any process
can open the voice connection. You forward them to `POST /v1/voice/sessions`, and camelRun holds the call: the voice
WebSocket, the UDP audio, and Discord's end-to-end encryption (DAVE).

Voice calls are off unless the runtime runs with `AGENT_VOICE=true` (see [Configuration](../operations/configuration.md)).
A runtime that holds calls needs to reach Discord's voice servers: WebSocket over TLS, and UDP out with replies let back
in (a stateful firewall or NAT whose UDP mappings outlive 5 seconds, as the connection sends a keepalive every 5). No
inbound port is opened. `scripts/voice-check.ts` checks it with two test bots (`infra/voice-check.sh` runs it in the
hosted runtime's network).

## Start a session

```ts
import { Agents } from "@camelai/run";
const agents = new Agents();

// On your gateway: OP 4 {guild_id, channel_id, self_mute: true, self_deaf: false}; then, from Discord's answers:
const session = await agents.voice.create({
  discord: { guildId, channelId, userId: botUserId, sessionId: voiceState.session_id, endpoint: voiceServer.endpoint, token: voiceServer.token },
  subject: ownerId,                 // whose usage it is (and whose credit, with end-user credits)
  metadata: { botId: 42 },          // echoed in every voice.* event
  ignoreUserIds: otherBotIds,       // never transcribed, and not company in the call
});
// People must know they are transcribed: post the notice in the voice channel's chat now.
await postMessage(session.notice.channelId, session.notice.text);
```

```python
session = await agents.voice.create(
    {"guildId": guild_id, "channelId": channel_id, "userId": bot_user_id, "sessionId": state["session_id"],
     "endpoint": server["endpoint"], "token": server["token"]},
    subject=owner_id, metadata={"botId": 42})
```

```bash
curl -X POST "$RUNTIME/v1/voice/sessions" -H "Authorization: Bearer $CAMELAI_API_KEY" -H "Content-Type: application/json" \
  -d '{"discord": {"guildId": "…", "channelId": "…", "userId": "…", "sessionId": "…", "endpoint": "c-ams12-1a2b.discord.media:443", "token": "…"},
       "subject": "user_42", "language": "en"}'
```

The answer is the session (`id`, `state: "connecting"`, its settings) and `notice`. A bot has one session per server, as
Discord allows one voice connection per user and server: a second `POST` for the same bot and server is a 409
`VOICE_SESSION_EXISTS` naming the live one.

| Field | |
| --- | --- |
| `discord` | `guildId`, `channelId`, `userId` (the bot), `sessionId`, `endpoint` (a `*.discord.media` host), `token`. The token is stored encrypted, never returned, and dropped when the session ends |
| `subject`, `context`, `keyScope` | whose usage it is (`usage.recorded`'s `subject`), your claims in its `context`, and a [key scope](models-and-keys.md#key-scopes) whose OpenAI key transcribes |
| `bucket` | with end-user credits on: which of the subject's buckets pays |
| `deliver` | `webhooks` (default `true`): `voice.*` events to your endpoints; `agent`: each utterance as a prompt to that agent |
| `language`, `prompt` | the language spoken (`en`, `pt-BR`; detected per utterance when left out), and words to expect (names, jargon) |
| `silenceMs` | silence that ends an utterance: 200 to 5000, default 800 |
| `maxMinutes`, `idleMinutes`, `emptySeconds` | the session ends after `maxMinutes` (default 240, at most 720), after `idleMinutes` without speech (default 30), or with no one else in the call for `emptySeconds` (default 60) |
| `ignoreUserIds` | users never transcribed and not counted as company: other bots |
| `metadata` | anything, at most 4 KB of JSON, echoed in every `voice.*` event |
| `notice` | the notice text (`{bot}` is the bot's id); by default "<@bot> is listening and transcribing speech in this channel. Audio is not stored." (with `speak`, "…listening, transcribing speech and may speak…") |
| `speak` | the bot may [speak](#speaking) in the call: `true`, or `{agentReplies: true}` to also [speak `deliver.agent`'s replies](#speaking-an-agents-replies) (default `false`). Your app joins with `self_mute: false`: the answer's `join` says how it should have joined |
| `bargeIn` | with `speak`: a person starting to talk stops what the bot is saying (default `true`) |
| `voice` | with `speak`: the voice its speech is made in (default `alloy`; OpenAI's voices: `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`, `verse`…) |

## Keep it connected, and end it

Discord moves calls: a voice server restarts or changes, or someone drags the bot to another channel. Your gateway
then gets a new `VOICE_SERVER_UPDATE` (or a `VOICE_STATE_UPDATE` for the bot with a new channel). Forward what changed:

```ts
await agents.voice.update(session.id, { discord: { endpoint: voiceServer.endpoint, token: voiceServer.token } });
```

`PATCH /v1/voice/sessions/{id}` takes `discord.channelId`, `sessionId`, `endpoint` (null: Discord is moving the call;
send the next one) and `token`, and `ignoreUserIds` and `metadata`. A session whose connection was refused (the bot was
disconnected or kicked, or Discord stopped taking its credentials) waits 15 seconds for new ones, then ends.

To leave, end the session and send the answer's `leave` on your gateway: ending stops the listening, and only your
gateway can take the bot out of the channel.

```ts
const { leave } = await agents.voice.end(session.id);   // DELETE /v1/voice/sessions/{id}
gateway.send(leave);                                      // {op: 4, d: {guild_id, channel_id: null, …}}
```

When camelRun ends a session itself (`voice.session.ended` with a `reason` other than `requested`), send the same OP 4
to leave. When your gateway sees the bot's own `VOICE_STATE_UPDATE` with `channel_id: null` (kicked), end the session.

`GET /v1/voice/sessions/{id}` reads one (`state`: `connecting`, `live`, `reconnecting`, `ended`; `utterances`,
`speechSeconds`, `costUsd`); `GET /v1/voice/sessions?state=live` lists them, newest first, a page at a time. Ended
sessions are listed for 30 days.

## Utterances

Each person's audio is cut into utterances: their speech until `silenceMs` passes without any, at most 30 seconds each
(a longer monologue goes on in the next), and none with less than 300 ms of speech. Silence is either no audio (a
person's client stops sending when they stop talking) or quiet audio, under -45 dBFS: a sender that never stops (a bot
playing a file, a client set to transmit always) sends encoded silence in its pauses. Quiet beyond 200 ms before and
after the speech is trimmed. Each is transcribed as
[`POST /v1/transcriptions`](voice.md#transcribing-on-its-own) transcribes audio, in the order each person spoke.

With `deliver.webhooks`, each goes to your [webhook endpoints](webhooks.md) that select `voice.utterance`:

```json
{"id": "evt_…", "type": "voice.utterance", "created": 1790000000,
 "data": {"session": "vs_…", "provider": "discord", "guildId": "…", "channelId": "…", "botUserId": "…",
          "speakerId": "<the Discord user who spoke>", "seq": 12, "text": "Can you add that to the list?", "language": "en",
          "seconds": 2.4, "startedAt": 1790000000000, "endedAt": 1790000002400, "ended": "silence", "costUsd": 0.000225,
          "subject": "user_42", "metadata": {"botId": 42}}}
```

`ended` says why it ended: `silence`; `max` (cut at 30 s); `error` (the speaker's audio broke off); `handoff` (the
session moved to another node of the runtime, which goes on from the next); `end` (the session ended). `seq` numbers
them in the order their transcripts were made. An utterance that transcribes to nothing is billed but not sent.

A runtime may instead transcribe utterances as they are spoken (off by default; its operator turns it on with
`AGENT_VOICE_LIVE_TRANSCRIPTION=true`): each person's audio streams to OpenAI's Realtime transcription
(`gpt-live-transcribe`) while they talk, and the cut commits it. Measured, that brings the transcript at most about
200 ms sooner, at the [live transcription price](../pricing.md) (3.8 times the other, per second sent, including the
quiet up to `silenceMs` after the speech). If it fails, the utterance is transcribed after it is cut; the event is the
same either way.

With `deliver.agent`, each is a prompt to that agent, from its speaker (`from: {id: speakerId}`), with metadata
`{voiceSession, utterance}`; the agent's runs answer as any run does (`run.completed`, its events). A deleted agent gets
nothing more.

`voice.session.started` tells that the session connected (once), and `voice.session.ended` that it ended, with `reason`
(`requested`, `empty`, `idle`, `max_duration`, `budget`, `kicked`, `credentials`, `error`), `limit` and
`endUserReason` with `budget`, and the session's totals.

## Speaking

A session started with `speak: true` can talk: what you send it is made into speech with OpenAI's `gpt-4o-mini-tts` and
played in the call by the bot. Join un-muted (OP 4 with `self_mute: false`).

```ts
const { speechId } = await agents.voice.speak(session.id, { text: "Hi! I'm taking notes for this call.", instructions: "Warm and brief." });
await agents.voice.stopSpeaking(session.id);   // stop what it is saying, and what it was going to
```

```python
speech = await agents.voice.speak(session["id"], "Hi! I'm taking notes for this call.", instructions="Warm and brief.")
await agents.voice.stop_speaking(session["id"])
```

`POST /v1/voice/sessions/{id}/speak` takes `text` (1 to 4,000 characters), `voice` (another than the session's, for
this speech), `instructions` (how to say it: tone, pace, accent; at most 1,000 characters) and `interrupt` (stop what
is playing and clear the queue first). It answers 202 with `speechId` and `position` (speeches ahead of it): speeches
play one at a time, in order, at most 20 waiting. `DELETE /v1/voice/sessions/{id}/speak` stops what the bot is saying
and clears the queue.

- **Events.** `voice.speech.started` (`speechId`, `latencyMs` from the request to the first audio) and
  `voice.speech.ended` (`speechId`, `reason`: `done`, `interrupted` or `error`; `by` with interrupted: `interrupt`,
  `requested`, `barge_in`, `end`, `handoff` or `budget`; `seconds` made and `costUsd`). A speech that never started
  ends `interrupted` with 0 seconds.
- **Barge-in.** With `bargeIn` (the default), a person starting to talk (not the bot, not `ignoreUserIds`) stops the
  speech playing and clears the queue (`by: "barge_in"`), so the bot does not talk over people.
- **Latency.** Speech plays as it is made: OpenAI streams it, and each 20 ms is encoded and sent as it comes, so the
  first audio goes out well before the whole is made (`latencyMs` measures it per speech).
- **Its own voice.** What the bot says is never transcribed (Discord does not send a bot its own audio, and the
  session ignores the bot's user), and does not count as speech for `idleMinutes` or company for `emptySeconds`.
- **Requests go where the call is.** Any node takes the request and passes it to the one holding the call; while the
  session moves between nodes, a 503 says to retry (the SDKs do).

### Speaking an agent's replies

With `deliver.agent` and `speak: {agentReplies: true}`, the session speaks the agent's reply to each utterance itself,
as the agent writes it: each sentence is made into speech and played as soon as it is whole, so the bot starts
answering while the agent is still writing. What is spoken is what a person would say aloud: markdown's marks, links'
addresses, bare URLs and code blocks are left out, and at most 400 characters are spoken (cut at a word). The whole
reply is still the run's (`run.completed`, the agent's history). Each sentence is a speech, with `reply: {agent,
requestId}` in its `voice.speech.*` events. A person starting to talk (barge-in), an interrupting speech or `DELETE
…/speak` stops the rest of the reply too.

### Speaking a prompt's reply

To choose per utterance whether and which agent answers (a wake word, a different agent per channel), leave out
`deliver.agent`, read the transcripts from `voice.utterance` webhooks, and prompt the agent yourself with `speak`:

```http
POST /v1/agents/{agent}/prompt
{"text": "What's on the calendar today?", "speak": {"session": "vs_…", "voice": "verse", "interrupt": true}}
```

The run's reply is spoken in that session as `agentReplies` speaks one: sentence by sentence as it is written, with the
same cleanup, 400-character cap and barge-in, each speech's events carrying `reply: {agent, requestId}`. The session
must be one of yours that speaks and has not ended (404, or 409 `VOICE_SPEAK_DISABLED` / `VOICE_SESSION_ENDED`, before
the prompt is taken); the agent and the session may be on different nodes. `voice` overrides the session's for this
reply; `interrupt` has its first sentence stop what the session is saying. Not with `whileRunning: "steer"`. A prompt
sent again with its request id is not spoken again. SDKs: `prompt(text, { speak })`, `submit(text, { speak })` (Python
`speak={...}`).

Prompted with your API key, any of your sessions may speak. Prompted with an agent's own token (which may be in an end
user's browser), only a session whose `subject` is the agent's: an agent without a subject, or a session of another
subject, is a 403 `VOICE_SPEAK_FORBIDDEN`, so one user cannot make another's bot talk.

## Speech providers

A session picks who transcribes and who speaks, each as providers to try in order. Each provider uses your key for it
(`PUT /v1/providers/<provider>/key`, or a key scope's), else the platform's where your account
may use the platform's keys. A provider with no key is skipped.

```http
POST /v1/voice/sessions
{"discord": {…}, "language": "en", "speak": true,
 "transcription": {"providers": ["deepgram/flux", "soniox", "openai"], "keyterms": ["camelRun", "Miguel"]},
 "speech": {"providers": ["elevenlabs", "cartesia", "openai"],
            "voices": {"elevenlabs": "21m00Tcm4TlvDq8ikWAM", "cartesia": "<a Cartesia voice id>", "openai": "coral"}}}
```

**Transcription** (`transcription.providers`) streams each person's audio to the first provider as they talk. The cut
commits the utterance, so its transcript follows the end of speech by the provider's last step. Each name is
`<provider>` (its default model) or `<provider>/<model>`:

| Provider | Default model | Notes |
| --- | --- | --- |
| `deepgram` | `nova-3` | Interim words as they are heard. Without `language` it hears many languages (`nova-3-multilingual`, priced so) |
| `deepgram/flux` | `flux-general-en` | Built for conversation: it says where turns end itself, early and for sure. English only |
| `soniox` | `stt-rt-v3` | 60 languages, switching mid-stream; `language` is a hint, `prompt` and `keyterms` its context |
| `assemblyai` | `universal-streaming-english` | Any of its streaming models by name: `assemblyai/<speech_model>` |
| `openai` | `gpt-live-transcribe` | OpenAI's Realtime transcription. What was just said prompts the next utterance, so names carry over |

- **Failover mid-utterance.** The utterance's audio is kept until its transcript comes. If the serving provider fails
  (its connection drops, it errs, or it has not answered 3 s after the cut), the next provider gets the utterance whole.
- **Last resort.** If every provider fails, the utterance is transcribed after it is cut, with OpenAI's
  `gpt-transcribe`.
- **`keyterms`.** Names and jargon to listen for, at most 100 terms. They go to each provider in the form it takes them.
- **Default.** Without `transcription.providers`, the session uses the runtime's chain (`AGENT_VOICE_STT`). With no
  chain set on the runtime, each utterance is transcribed after it ends.

**Speech** (`speech.providers`) is made by the first provider that can. Each streams 24 kHz audio as it is made, and the
bot plays it as it comes:

| Provider | Default model | Voice (`speech.voices.<provider>`) |
| --- | --- | --- |
| `elevenlabs` | `eleven_flash_v2_5` (its fastest) | An ElevenLabs voice id. Default: the premade "Rachel" |
| `cartesia` | `sonic-3` | A Cartesia voice id. Required: Cartesia is skipped without one |
| `deepgram` | `aura-2` | An Aura voice. Default: `aura-2-thalia-en` |
| `openai` | `gpt-4o-mini-tts` | `voice` (alloy, coral, verse…). Takes `instructions` |

A provider that fails, or that sends no audio within 3 s, is passed over for the next one. Once the bot has started
speaking, a failure ends that speech (`voice.speech.ended` with `reason: "error"`): another voice cannot carry on
mid-sentence. Without `speech.providers`, a session uses the runtime's chain (`AGENT_VOICE_TTS`), else OpenAI. The
session's `language` tells providers that speak many languages which one to pronounce.

Usage records name the provider and model that served, `deepgram/nova-3` or `elevenlabs/eleven_flash_v2_5` for
example, as `usage.recorded`'s `provider` and `model`.

## Cost

Only speech is paid for: Discord sends no audio while people are silent, quiet audio is trimmed from each utterance, and
each utterance is transcribed at the
[transcription price](../pricing.md), per second, as `usage.recorded` with `kind: "transcription"`, the session's
`subject`, and `context.voiceSession`. Holding the call itself costs nothing.

Speech the bot says is billed as its provider bills it, at the [speech price](../pricing.md). OpenAI's is $0.015 a
minute on the platform's key, per second of speech made. ElevenLabs, Cartesia and Deepgram Aura bill per character of
the text. Each speech is a `usage.recorded` with `kind: "speech"` and `audioSeconds`. A speech cut short pays for what
was made: its seconds made with OpenAI, and its whole text with a provider that bills per character. Transcription
through another provider is billed at that provider's price, per second of audio streamed. On your own key the
provider bills you directly; the usage record still carries the cost. With end-user credits, each speech holds its estimate of the subject's credit before it is made and settles
at what it cost; running out ends the session (`budget`).

A session starts only when the account may spend (402 `SPEND_LIMIT` otherwise) and has a key to transcribe with: OpenAI's, or one of its transcription providers'
(400 `TRANSCRIPTION_UNAVAILABLE`). An account that runs out during a call ends it: `reason: "budget"`, `limit: "tenant"`.
With end-user credits on, a subject with nothing left is refused at the start (402 `END_USER_CREDIT`), each utterance
holds its cost of the subject's credit before it is transcribed, and running out ends the session (`limit:
"end_user"`).

## Privacy and your duties

- People in the call must know they are being transcribed. camelRun cannot post in Discord, so your app posts
  `notice.text` in the voice channel's chat when it joins, from code your bot's authors cannot turn off. Telling them
  is your app's job: camelRun cannot check it.
- Audio is never stored: it is held in memory until its utterance is transcribed, then dropped. Transcripts are not kept
  beyond delivery (an undelivered webhook event is retried for up to 3 days; an agent keeps its prompts in its history).
  Logs carry ids, lengths and counts, never audio or text.
- An utterance being transcribed when a runtime node is lost is lost with it (its audio was only in that node's memory).
  Once its transcript is written, it is delivered at least once: dedupe webhook events by `id`.
- Discord's end-to-end encryption (DAVE) is checked: a member of the call's encryption group that Discord's voice
  server never named drops the connection, which joins again with a new group.
- Text a session speaks goes to OpenAI to be made into speech, under its API data policy (not used for training); the
  speech is played and dropped, never stored. Logs carry its length and timings, never the text.
- A bot that speaks sends audio its call's encryption group can decrypt, so its group is checked strictly: a Welcome
  into a group with a member Discord's voice server never named is refused at once (and the bot is welcomed again into
  one of the call's members), and speech goes out only while every member of the group is named and the group is
  ready (never unencrypted while it re-forms).
- Discord does not document receiving audio for bots, though every recording bot does it; it may change without notice.

## Limits

| | |
| --- | --- |
| Live sessions per account | 10 (`AGENT_VOICE_SESSIONS_PER_TENANT`; an operator can set an account's own, `maxVoiceSessions`) |
| Sessions per bot and server | 1 |
| Session length | `maxMinutes`, at most 720 |
| Utterance | 300 ms to 30 s |
| Reconnect wait for new credentials | 15 s |
