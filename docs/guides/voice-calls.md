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
| `addressing` | which turns are the bot's in a group call: `{names, mode, conversationMs}`; see [who it answers](#who-it-answers) (default: every turn) |
| `endOfTurn` | how a speaker's turn (an utterance) ends: `smart` (the default where the runtime has the models) or `silence`, or `{mode, commitMs, threshold, maxSilenceMs}`; see [turns](#turns) |
| `silenceMs` | with `endOfTurn: silence`: silence that ends an utterance: 200 to 5000, default 800 |
| `maxMinutes`, `idleMinutes`, `emptySeconds` | the session ends after `maxMinutes` (default 240, at most 720), after `idleMinutes` without speech (default 30), or with no one else in the call for `emptySeconds` (default 60) |
| `ignoreUserIds` | users never transcribed and not counted as company: other bots |
| `metadata` | anything, at most 4 KB of JSON, echoed in every `voice.*` event |
| `notice` | the notice text (`{bot}` is the bot's id); by default "<@bot> is listening and transcribing speech in this channel. Audio is not stored." (with `speak`, "…listening, transcribing speech and may speak…") |
| `speak` | the bot may [speak](#speaking) in the call: `true`, or `{agentReplies: true}` to also [speak `deliver.agent`'s replies](#speaking-an-agents-replies) (default `false`). Your app joins with `self_mute: false`: the answer's `join` says how it should have joined |
| `bargeIn` | with `speak`: a person talking over the bot stops what it is saying, unless it is the bot's own voice coming back (default `true`; or `{minMs, confirmMs, resumeMs, backchannels}`, see Barge-in) |
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

When Discord stops taking the credentials (its voice session ended), only your gateway can get new ones, so camelRun
says so at once: `voice.session.error` with `code: "credentials_needed"` (and `waitMs`, how long it waits). Send OP 4
for the same channel again, and forward what Discord answers (`VOICE_STATE_UPDATE`'s `session_id`,
`VOICE_SERVER_UPDATE`'s `endpoint` and `token`) with a PATCH: the session reconnects and goes on. A session moving
between camelRun's nodes keeps its credentials: the node letting it go drops its voice socket rather than closing it,
which would end Discord's voice session.

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

## Turns

An utterance is one speaker's turn. How it ends is `endOfTurn`:

- `smart` (the default where the runtime runs the turn models, which its operator turns on): speech is found by a voice activity model (Silero VAD),
  not by loudness, so room noise or an open mic is not speech. At each pause, after 200 ms of silence, a turn-detection
  model (Pipecat's Smart Turn, 23 languages) listens to the speaker's last 8 seconds and judges whether they are done.
  If they are, the turn ends at `commitMs` of silence (default 500; 200 to 3000). If they are mid-thought, they get up to
  `maxSilenceMs` (default 1400; 500 to 5000) before it ends anyway. `threshold` (0.05 to 0.95, default 0.5) is how
  sure it must be that they are done: higher waits more often.
- `silence`: the turn ends after `silenceMs` without speech, speech being audio over -45 dBFS.

Measured on 920 labelled turns in 23 languages (pipecat's smart-turn test set): with `smart` at its defaults, a turn
ends 580 ms after the last word (median; `silence` at 800 ms: 816 ms), and a speaker who pauses mid-thought is held
for them 87% of the time (`silence` cuts 99% of such pauses of 800 ms or more). A runtime without the models (its
operator has not set `AGENT_VOICE_TURN_MODELS=true`, or they could not load) ends turns on `silence`, and refuses
`smart`.

With live transcription on, a `smart` turn the model calls complete is transcribed from that moment, while the turn
waits out `commitMs`: its transcript comes that much sooner (if the speaker goes on, the rest is added to it).

## Who it answers

By default every turn goes to `deliver.agent`. In a group call that makes a bot answer everything said near it.
`addressing` makes it answer only the turns that are its own:

```ts
await agents.voice.create({ discord, deliver: { agent: agent.id }, speak: { agentReplies: true },
  addressing: { names: ["camel", "hey camel"] } });
```

With `names` (its wake words; `mode: "addressed"` is then the default), a turn is the bot's when:

- it says one of `names`, anywhere in it, as a word or phrase. A near miss of a name of five letters or more counts too
  ("jarvys" for "jarvis"), as speech recognition spells names;
- its speaker is in a conversation with the bot: the bot answered them, or they named it, within `conversationMs`
  (default 20 s), and no one else has named it since;
- or no one else is in the call.

The other turns still reach your webhooks (`voice.utterance` with `addressed: false`). The agent gets them as context
with the next turn that is the bot's: the prompt starts with `[Said in the call before this, not to you]` and those
turns (`<@speaker>: text`), then `[To you]` and the turn. Every `voice.utterance` says `addressed` and `addressedBy`
(`always`, `alone`, `named`, `conversation` or `not_addressed`).

With `speak: {agentReplies: true}` the bot says one reply at a time. A reply that has not started playing when a newer
turn's reply starts is not said (`voice.speech.ended` with `by: "superseded"`); the newer one is, and the agent has
both turns.

## Utterances

Each person's audio is cut into utterances: their speech until their turn ends (see [turns](#turns)), at most 30 seconds each
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

`voice.session.error` tells that the session's audio failed (`code: "media_crashed"`). Each session's audio is handled
apart from every other's, so a failure is its own. With `restarting: true` it reconnects at once, and the call goes on:
what the bot was saying ends (`voice.speech.ended`, `error`), and what someone was halfway through saying may be lost.
After 3 failures in 5 minutes it stops trying (`restarting: false`), and `voice.session.ended` (`error`) follows.

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
this speech: OpenAI's), `voices` (this speech's voice for each [speech provider](#speech-providers), by provider, over
the session's `speech.voices`: `{"elevenlabs": "<voice id>", "openai": "fable"}`), `instructions` (how to say it: tone,
pace, accent; at most 1,000 characters) and `interrupt` (stop what
is playing and clear the queue first). It answers 202 with `speechId` and `position` (speeches ahead of it): speeches
play one at a time, in order, at most 20 waiting. `DELETE /v1/voice/sessions/{id}/speak` stops what the bot is saying
and clears the queue.

- **Events.** `voice.speech.started` (`speechId`, `latencyMs` from the request to the first audio) and
  `voice.speech.ended` (`speechId`, `reason`: `done`, `interrupted` or `error`; `by` with interrupted: `interrupt`,
  `requested`, `barge_in`, `end`, `handoff` or `budget`; `seconds` made and `costUsd`). A speech that never started
  ends `interrupted` with 0 seconds.
- **Barge-in.** With `bargeIn` (the default), a person talking over the bot (not the bot, not `ignoreUserIds`) stops
  the speech playing and clears the queue (`by: "barge_in"`), so the bot does not talk over people. Someone on laptop
  speakers without headphones can send the bot's own voice back into the call, so the bot checks first:
  - After `minMs` (300) of their speech, it **pauses**. It keeps what it was saying.
  - If their words are the bot's own, in its order (echo), or they said nothing, it **resumes** where it paused.
  - If their words are anyone else's, it **stops**. If they keep talking for `confirmMs` (1000) after the pause, it
    stops without waiting for the words, since echo stops when the bot does.
  - The pause lasts at most `resumeMs` (3000). Then it stops if they are still talking, and resumes if not.
  - If all they said is a backchannel, showing they listen ("mm-hm", "yeah", "ok", "sí", "vale", "ja", "oui",
    "да", "haan", "嗯", "はい", "네"… in about 20 languages, and your `backchannels`), it **resumes**. A backchannel is
    not a turn of theirs either: like echo, it never reaches `deliver.agent`, and its webhook carries
    `backchannel: true`. "Yeah, but…" is words, and stops it.
  - With `endOfTurn: smart`, a turn that ends with less speech than words take (a cough, a click) resumes it at once.

  Pass `bargeIn: {minMs, confirmMs, resumeMs, backchannels}` to change the timing (and add backchannels); `confirmMs: 0` stops at `minMs` with no pause
  and no echo check. With live transcription the words come as they are said, so the decision is usually quicker.
  An utterance judged echo is the bot's voice, not the person's: it never reaches `deliver.agent` (no reply), and its
  `voice.utterance` webhook carries `echo: true` so your app can drop it too.
  Sessions show the timing in use as `interruption`. Logs: `voice_barge_in_candidate` (paused),
  `voice_barge_in_confirmed` and `voice_barge_in_echo_rejected` (`why`, `pausedMs`).
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

A provider that fails, or that sends no audible audio within 3 s (silence does not count, so a provider that streams
silence and stalls is caught), is passed over for the next one. Once the bot has started
speaking, a failure ends that speech (`voice.speech.ended` with `reason: "error"`): another voice cannot carry on
mid-sentence. Without `speech.providers`, a session uses the runtime's chain (`AGENT_VOICE_TTS`), else OpenAI. The
session's `language` tells providers that speak many languages which one to pronounce.

Usage records name the provider and model that served, `deepgram/nova-3` or `elevenlabs/eleven_flash_v2_5` for
example, as `usage.recorded`'s `provider` and `model`.
## From a browser

A session with `provider: "browser"` is a call from a web page, with no Discord in it: for trying a voice bot out
(a test panel, a preview) through the same pipeline a Discord call takes: cutting utterances, barge-in,
transcription, `speak`, agent replies. Create it from your server, and give the page only the answer's `browser.url`
and `browser.token`, never your API key:

```ts
const session = await fetch("https://run.camelai.com/v1/voice/sessions", {
  method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ provider: "browser", speak: true, deliver: { webhooks: false }, metadata: { preview: true } }),
}).then(response => response.json());
// In the page:
const socket = new WebSocket(`${session.browser.url}?token=${encodeURIComponent(session.browser.token)}`);
socket.binaryType = "arraybuffer";
```

A browser session needs no `discord`, and may deliver to neither webhooks nor an agent: its socket gets every
utterance itself. The token opens the socket for 10 minutes; `POST /v1/voice/sessions/{id}/browser-token` makes
another (a page that reloads). One socket is open at a time, and closing it hangs up: the call is then empty, and
`emptySeconds` ends the session.

The socket carries:

| Direction | Frame | What |
| --- | --- | --- |
| page → camelRun | binary, first byte `1` | An Opus packet, 20 ms at 48 kHz (mono or stereo, as WebCodecs' `AudioEncoder` makes it) |
| page → camelRun | binary, first byte `2` | 20 ms of 16-bit little-endian PCM, 48 kHz mono (1,920 bytes), which camelRun encodes |
| page → camelRun | `{"type":"speaker","id":"…"}` | Whose the frames that follow are (`browser` by default; letters, digits, `_` and `-`) |
| page → camelRun | `{"type":"others","users":[…]}` | Who else is "in the call" (an empty list lets `emptySeconds` end it) |
| page → camelRun | `{"type":"config","audio":"pcm"}` | The bot's speech as PCM rather than Opus |
| camelRun → page | binary, first byte `1` or `2` | The bot's speech, a frame every 20 ms as it plays: Opus (48 kHz stereo), or PCM (48 kHz mono) |
| camelRun → page | `{"type":"ready"}` | Connected |
| camelRun → page | `{"type":"utterance",…}` | Each utterance transcribed: `speakerId`, `seq`, `text`, `startedAt`, `endedAt`, `ended`, `transcriptMs`, and `turnCommitMs` in a session that speaks |
| camelRun → page | `{"type":"speech",…}` | `state: "started"` (`speechId`, `latencyMs`, `startedAt`) and `state: "ended"` (`reason`, `by`, `seconds`) |

The socket may reach any node: one that does not hold the session relays it to the one that does.

## Realtime brain (beta)

By default a session is a cascade: each utterance is transcribed, your app or `deliver.agent` writes the answer, and
text to speech says it. With `brain: "realtime"`, a speech-to-speech model hears the call and answers aloud itself, in
its own voice, without text in between. It hears tone and hesitation, and its prosody fits the moment; it asks the
bot's agent for anything beyond talk.

```ts
await agents.voice.create({
  discord, deliver: { agent: agent.id }, brain: "realtime",
  realtime: { instructions: "You are Mochi, a cheerful cat who loves puns.", voice: "marin" },
  speakers: { "400000000000000001": "Ana", "400000000000000002": "Ben" },
  addressing: { names: ["mochi"] },
});
```

It is off unless the runtime lists a provider in `AGENT_VOICE_REALTIME` (`openai`, `gemini`), and the account has a key
for it (your OpenAI key, or your `google` key for Gemini, under Models & keys, else the platform's; 400
`REALTIME_UNAVAILABLE` without one). The session speaks:
`speak` may be left out, and your app joins un-muted.

How it works:

- **Who said what.** Discord gives each person's audio apart; a model hears one stream. The session mixes them, and
  each time who speaks changes, it keeps what came before as its own item and adds a note naming who speaks next:
  `[Ana]`, or `[Ana and Ben, at once]` while two talk over each other. Names come from `speakers` (by user id; PATCH
  it as people join), else `Speaker 1`, `Speaker 2`…
- **Turns are ours.** The provider's own turn detection is off. A turn ends as it does in the cascade ([turns](#turns):
  Smart Turn, or silence), and only then is the model asked to answer. With smart turns it is asked at the likely end
  already (`realtime.speculative`, default true) and its audio waits for the turn to end; if the person goes on, it is
  taken back unheard. While someone else is mid-turn the answer waits for them, and their turn replaces it: one answer
  to both. The provider's VAD is not used: on a mixed stream it fires on anyone (chatter, echo), it cannot know who
  holds the floor, and it is no faster (the lifelike-voice probe: Gemini Live's first audio 1.2 s after the last word
  with its own VAD, 0.6 s after our commit).
- **Who it answers** follows [addressing](#who-it-answers): a turn from someone alone with the bot or in a conversation
  with it is answered at once. Otherwise, with `names`, the turn's transcript decides (named: answered; not: the model
  only listens). Without names, the model is told the turn did not name it, and calls `stay_silent` when people are
  talking to each other.
- **Barge-in** works as in the cascade: a person talking over the bot pauses it, the echo guard decides, and their own
  speech stops it. The model's answer is then cut where people stopped hearing it, so its memory of the call matches
  what was heard. Echo the guard rejects is dropped, not kept as someone's words.
- **Tools.** `ask_agent(request)` prompts `deliver.agent` (its tools, memory and system prompt; its run is billed as
  any run, with `metadata.via: "realtime"` and the speaker as `from`), and the model says its answer in its own words.
  The model fills the wait itself ("let me check"). A reply not in after 45 seconds: the model is told the agent is
  still working (and says so), and the reply, when it comes (within 5 minutes), is said then. Without `deliver.agent`
  there is no `ask_agent`. `stay_silent()` answers nothing.
- **One character.** `realtime.instructions` (at most 8,000 characters) is the bot's persona, before the call's own
  rules (short spoken answers, names, stay_silent, and with an agent: the model is the bot's voice and asks the agent
  for anything beyond small talk). Give it the same persona as the agent, and say what the agent can do (its tools),
  so the model knows what to ask it.

`realtime` takes `provider` (`openai` or `gemini`; default the runtime's first), `model` (OpenAI: `gpt-realtime-2.1`, the
default, or `gpt-realtime-2.1-mini`; Gemini: `gemini-3.8-live`), `voice` (the model's. OpenAI: `alloy`, `ash`, `ballad`,
`coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`; Gemini: its prebuilt voices, `Kore`, `Aoede`, `Leda`,
`Puck`, `Charon`… Default the session's `voice`, or the nearest: OpenAI `nova` → `marin`, `onyx` → `cedar`, `fable` →
`ballad`; Gemini `coral` → `Kore`, `alloy` → `Aoede`, `onyx` → `Charon`…), `instructions`, `transcribe` (default true:
what people say is transcribed, for `names` and for `voice.utterance`) and `speculative`.

The providers differ where their APIs do. Gemini Live hears a turn as one activity (a change of speaker inside it is a
note in its context), transcribes it only once it is asked to answer (a turn that only its words could address is
answered at once, and taken back before it is heard if they do not name the bot), cannot drop audio once sent (echo
the guard rejects stays in its context), and is told how much of a cut-off answer was heard rather than having it
truncated.

What changes for your app: `voice.utterance` still comes for each person's speech (with `brain: "realtime"`; with
`transcribe`), but the model has answered it already, so your app should not. `POST …/speak` is refused (409
`VOICE_REALTIME`); `DELETE …/speak` stops what the bot says. The cascade's `speak.agentReplies`,
`transcription.providers` and `speech` do not apply. `voice.speech.started` and `voice.speech.ended` come for each
answer played, with `brain: "realtime"`.

Each answer's first audio is timed as a cascade turn is: `voice_turn_latency` with `Path=realtime`, from the end of
speech (`turnCommit`, `ttsFirstAudio`: the model's first audio, `firstPacket`), plus `VoiceRealtimeMs` (commit to the
model's first audio). When the session is let go, `voice_realtime_stats` counts its turns, answers, ask_agent and
stay_silent calls, barge-ins and speculation taken back.

A provider connection that drops is opened again (three times in five minutes at most, else the session ends with
`error`, `realtime_failed`), told what was said lately. A session that moves to another node starts a new conversation
the same way.

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

A realtime brain is billed by the tokens its model uses, at the provider's list price on the platform's key: each
answer is a `usage.recorded` with `kind: "speech"`, the model as `model`, its tokens in `input` and `output` (`cacheRead`
for cached ones) and `audioSeconds` of audio made. Each answer bills the conversation so far again (mostly cached, at a
tenth or less of the price), so a minute costs more as a call goes on. A conversational minute (people talk half of
it, the bot a third) is about $0.05 on `gpt-realtime-2.1`, $0.02 on `gpt-realtime-2.1-mini` and $0.02-0.035 on
`gemini-3.8-live` (measured), against $0.015-0.02 for the cascade. What people say is transcribed (`transcribe`) at the transcription price, as `kind: "transcription"`.
With end-user credits, each answer holds $0.05 of the subject's credit before it is asked for and settles at what it
cost.

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
- With a realtime brain, the call's audio goes to the provider (OpenAI) as it is spoken, and the model's answers come
  back as audio; neither is stored by camelRun, and the provider keeps them under its API data policy. What was said
  lately is held in memory (to brief a new connection), never written.
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
