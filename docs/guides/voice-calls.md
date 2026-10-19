# Voice calls

camelRun can sit in a Discord voice call for your bot and talk with the people in it: a realtime speech-to-speech model
hears the call and answers aloud, and asks your bot's agent for anything beyond talk. What people say also goes to your
webhooks, transcribed. Your app keeps its Discord gateway and its bot token; camelRun never sees either.

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

// On your gateway: OP 4 {guild_id, channel_id, self_mute: false, self_deaf: false}; then, from Discord's answers:
const session = await agents.voice.create({
  discord: { guildId, channelId, userId: botUserId, sessionId: voiceState.session_id, endpoint: voiceServer.endpoint, token: voiceServer.token },
  deliver: { agent: agent.id },     // the bot's agent, which the model asks for facts and actions
  realtime: { instructions: "You are Mochi, a cheerful cat who loves puns." },
  subject: ownerId,                 // whose usage it is (and whose credit, with end-user credits)
  metadata: { botId: 42 },          // echoed in every voice.* event
  ignoreUserIds: otherBotIds,       // never heard, and not company in the call
});
// People must know they are transcribed: post the notice in the voice channel's chat now.
await postMessage(session.notice.channelId, session.notice.text);
```

```python
session = await agents.voice.create(
    {"guildId": guild_id, "channelId": channel_id, "userId": bot_user_id, "sessionId": state["session_id"],
     "endpoint": server["endpoint"], "token": server["token"]},
    agent=agent_id, realtime={"instructions": "You are Mochi, a cheerful cat who loves puns."},
    subject=owner_id, metadata={"botId": 42})
```

```bash
curl -X POST "$RUNTIME/v1/voice/sessions" -H "Authorization: Bearer $CAMELAI_API_KEY" -H "Content-Type: application/json" \
  -d '{"discord": {"guildId": "…", "channelId": "…", "userId": "…", "sessionId": "…", "endpoint": "c-ams12-1a2b.discord.media:443", "token": "…"},
       "deliver": {"agent": "client_…"}, "subject": "user_42", "language": "en"}'
```

The answer is the session (`id`, `state: "connecting"`, its settings) and `notice`. A bot has one session per server, as
Discord allows one voice connection per user and server: a second `POST` for the same bot and server is a 409
`VOICE_SESSION_EXISTS` naming the live one.

| Field | |
| --- | --- |
| `discord` | `guildId`, `channelId`, `userId` (the bot), `sessionId`, `endpoint` (a `*.discord.media` host), `token`. The token is stored encrypted, never returned, and dropped when the session ends |
| `realtime` | the model that answers: `{provider, model, voice, instructions, transcribe, speculative}`; see [the realtime brain](#the-realtime-brain) |
| `subject`, `context`, `keyScope` | whose usage it is (`usage.recorded`'s `subject`), your claims in its `context`, and a [key scope](models-and-keys.md#key-scopes) whose key for the realtime provider is used |
| `bucket` | with end-user credits on: which of the subject's buckets pays |
| `deliver` | `agent`: the bot's agent, which the model asks for anything beyond talk (`ask_agent`); `webhooks` (default `true`): `voice.*` events to your endpoints |
| `language`, `prompt` | the language spoken (`en`, `pt-BR`; detected when left out), and words to expect (names, jargon), for the transcripts |
| `addressing` | which turns are the bot's in a group call: `{names, mode, conversationMs}`; see [who it answers](#who-it-answers) (default: every turn) |
| `endOfTurn` | how a speaker's turn ends: `smart` (the default where the runtime has the models) or `silence`, or `{mode, commitMs, threshold, maxSilenceMs}`; see [turns](#turns) |
| `silenceMs` | with `endOfTurn: silence`: silence that ends a turn: 200 to 5000, default 800 |
| `maxMinutes`, `idleMinutes`, `emptySeconds` | the session ends after `maxMinutes` (default 240, at most 720), after `idleMinutes` without speech (default 30), or with no one else in the call for `emptySeconds` (default 60) |
| `ignoreUserIds` | users never heard and not counted as company: other bots |
| `metadata` | anything, at most 4 KB of JSON, echoed in every `voice.*` event |
| `notice` | the notice text (`{bot}` is the bot's id); by default "<@bot> is listening, transcribing speech and may speak in this channel. Audio is not stored." |
| `bargeIn` | a person talking over the bot stops what it is saying, unless it is the bot's own voice coming back (default `true`; or `{minMs, confirmMs, resumeMs}`, see [barge-in](#barge-in)) |
| `voice` | the bot's voice by OpenAI's names (`alloy`, the default, `coral`, `nova`…), mapped to the provider's nearest; `realtime.voice` names the provider's own |
| `speakers` | names by Discord user id, for the model's note of who speaks (`{"400000000000000001": "Ana"}`); PATCH it as people join |
| `brain` | `realtime` (the default): the model hears the call and answers; `listen`: muted, transcribed only (see [listening only](#listening-only)) |

The bot speaks, so your app joins un-muted (OP 4 with `self_mute: false`): the answer's `join` says so.

## Listening only

A bot that only needs to hear the call (notes, captions, commands it acts on in text) takes `brain: "listen"`. Nothing
answers: no realtime model is opened, and the bot never speaks, so your app joins muted (`join.self_mute: true`). Each
utterance is transcribed once its speaker's turn ends (OpenAI's `gpt-transcribe`, as [`POST /v1/transcriptions`](voice.md)
transcribes, on your OpenAI key or the platform's) and goes to your webhooks as `voice.utterance` with `brain:
"listen"` (no `addressed`), or to the page of a browser session. Its notice says the bot listens and transcribes; it
does not say it may speak.

A listening session takes `language`, `prompt` (words to expect), `endOfTurn`, `silenceMs` and the session's limits; it
ignores `speak`, `bargeIn`, `voice`, `addressing`, `realtime`, `speakers` and `deliver.agent` if sent, and needs
`deliver.webhooks` on (a browser session's page gets every utterance itself). Each utterance is billed as a
transcription (`usage.recorded` `kind: "transcription"`), held against the subject's credit first with end-user credits
on. `DELETE …/speak` is a 409 `VOICE_SPEAK_DISABLED`.

## Keep it connected, and end it

Discord moves calls: a voice server restarts or changes, or someone drags the bot to another channel. Your gateway
then gets a new `VOICE_SERVER_UPDATE` (or a `VOICE_STATE_UPDATE` for the bot with a new channel). Forward what changed:

```ts
await agents.voice.update(session.id, { discord: { endpoint: voiceServer.endpoint, token: voiceServer.token } });
```

`PATCH /v1/voice/sessions/{id}` takes `discord.channelId`, `sessionId`, `endpoint` (null: Discord is moving the call;
send the next one) and `token`, and `ignoreUserIds`, `metadata` and `speakers`. A session whose connection was refused (the bot was
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
`speechSeconds`, `speeches`, `spokenSeconds`, `costUsd`); `GET /v1/voice/sessions?state=live` lists them, newest first, a page at a time. Ended
sessions are listed for 30 days.

## Turns

A turn is one speaker's stretch of speech, and the model is asked to answer when it ends. How it ends is `endOfTurn`:

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

The provider's own turn detection is off: on a mixed stream it fires on anyone (chatter, echo), it cannot know who
holds the floor, and it is no faster (Gemini Live's first audio came 1.2 s after the last word with its own VAD, 0.6 s
after our commit). With `smart`, the model is asked to answer already at the likely end (`realtime.speculative`, default
true), and its audio waits for the turn to end; if the person goes on, it is taken back unheard. While someone else is
mid-turn the answer waits for them, and their turn replaces it: one answer to both.

## Who it answers

By default every turn is answered. In a group call that makes a bot answer everything said near it. `addressing` makes
it answer only the turns that are its own:

```ts
await agents.voice.create({ discord, deliver: { agent: agent.id }, addressing: { names: ["camel", "hey camel"] } });
```

With `names` (its wake words; `mode: "addressed"` is then the default), a turn is the bot's when:

- it says one of `names`, anywhere in it, as a word or phrase. A near miss of a name of five letters or more counts too
  ("jarvys" for "jarvis"), as speech recognition spells names;
- its speaker is in a conversation with the bot: the bot answered them, or they named it, within `conversationMs`
  (default 20 s), and no one else has named it since;
- or no one else is in the call.

A turn from someone alone with the bot, or in a conversation with it, is answered at once. Otherwise, with `names`,
the turn's transcript decides (named: answered; not: the model only listens, and hears it as context). Without names,
the model is told the turn did not name it, and calls `stay_silent` when people are talking to each other. The other
turns still reach your webhooks (`voice.utterance` with `addressed: false`). Every `voice.utterance` says `addressed`
and `addressedBy` (`always`, `alone`, `named`, `conversation` or `not_addressed`).

## The realtime brain

A speech-to-speech model hears the call and answers aloud, in its own voice, without text in between. It hears tone and
hesitation, its prosody fits the moment, and it asks the bot's agent for anything beyond talk.

```ts
await agents.voice.create({
  discord, deliver: { agent: agent.id },
  realtime: { instructions: "You are Mochi, a cheerful cat who loves puns.", voice: "marin" },
  speakers: { "400000000000000001": "Ana", "400000000000000002": "Ben" },
  addressing: { names: ["mochi"] },
});
```

The runtime offers the providers its `AGENT_VOICE_REALTIME` lists (`openai`, `gemini`, `grok`, `elevenlabs`; OpenAI
when unset). The account needs a key for the session's provider: your OpenAI key, your `google` key for Gemini, your
`xai` key for Grok, or your `elevenlabs` key for ElevenLabs Agents, under Models & keys, else the platform's (400
`REALTIME_UNAVAILABLE` without one).

How it works:

- **Who said what.** Discord gives each person's audio apart; a model hears one stream. The session mixes them, and
  each time who speaks changes, it keeps what came before as its own item and adds a note naming who speaks next:
  `[Ana]`, or `[Ana and Ben, at once]` while two talk over each other. Names come from `speakers` (by user id; PATCH
  it as people join), else `Speaker 1`, `Speaker 2`…
- **Turns are ours** for OpenAI, Gemini and Grok: their own turn detection is off. A turn ends as [turns](#turns) says
  (Smart Turn, or silence), and only then is the model asked to answer (or at the likely end, with `speculative`).
  ElevenLabs Agents ends turns itself (see below).
- **Who it answers** follows [addressing](#who-it-answers).
- **Tools.** `ask_agent(request)` prompts `deliver.agent` (its tools, memory and system prompt; its run is billed as
  any run, with `metadata.via: "realtime"` and the speaker as `from`), and the model says its answer in its own words.
  The model fills the wait itself ("let me check"). A reply not in after 45 seconds: the model is told the agent is
  still working (and says so), and the reply, when it comes (within 5 minutes), is said then. Without `deliver.agent`
  there is no `ask_agent`. `stay_silent()` answers nothing.
- **One character.** `realtime.instructions` (at most 8,000 characters) is the bot's persona, before the call's own
  rules (short spoken answers, names, stay_silent, and with an agent: the model is the bot's voice and asks the agent
  for anything beyond small talk). Give it the same persona as the agent, and say what the agent can do (its tools),
  so the model knows what to ask it.

`realtime` takes `provider` (`openai`, `gemini`, `grok`, or `elevenlabs`; default the runtime's first), `model` (OpenAI: `gpt-realtime-2.1`, the
default, or `gpt-realtime-2.1-mini`; Gemini: `gemini-3.8-live`; Grok: `grok-voice-latest` or `grok-voice-3.0`; ElevenLabs: `gemini-2.5-flash-lite`), `voice` (the model's. OpenAI: `alloy`, `ash`, `ballad`,
`coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`; Gemini: its prebuilt voices, `Kore`, `Aoede`, `Leda`,
`Puck`, `Charon`… Default the session's `voice`, or the nearest: OpenAI `nova` → `marin`, `onyx` → `cedar`, `fable` →
`ballad`; Gemini `coral` → `Kore`, `alloy` → `Aoede`, `onyx` → `Charon`…), `instructions`, `transcribe` (default true:
what people say is transcribed, for `names` and for `voice.utterance`) and `speculative`.

ElevenLabs Agents uses its own VAD and turn detection, so `speculative` is disabled. Its built-in LLM is the
voice front-end; `ask_agent` and `stay_silent` are client tools. Set `realtime.voice` to a library voice_id your key can
use; OpenAI voice names map to Jessica. Speaker labels are contextual updates around mixed audio, with no reliable
attribution for overlapping speech. Interruptions stop buffered playback; streamed input cannot be withdrawn.
Addressing is decided by the voice model from the call instructions, rather than the local named-turn gate.
The runtime lazily creates or reuses one private agent per credential, with per-session overrides and signed URLs
(see [configuration](../operations/configuration.md)). Conversation token counts are unavailable. Connection duration is billed through the normal speech usage records
and end-user credit holds, including silent time and interrupted responses. Configure both
`AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD` and `AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD`: the former from the
[Agents pricing page](https://elevenlabs.io/pricing/agents), the latter from Gemini Flash Lite's Detailed costs estimate
in the agent settings. LLM usage is billed separately by ElevenLabs; this runtime uses the configured per-minute
estimate, not post-call token reconciliation. Missing either rate refuses sessions with `REALTIME_UNPRICED`.
Silence discounts, burst surcharges and account-specific allowances are not reconciled.

The providers differ where their APIs do. Gemini Live hears a turn as one activity (a change of speaker inside it is a
note in its context), transcribes it only once it is asked to answer (a turn that only its words could address is
answered at once, and taken back before it is heard if they do not name the bot), cannot drop audio once sent (echo
the guard rejects stays in its context), and is told how much of a cut-off answer was heard rather than having it
truncated.

A provider connection that drops is opened again (three times in five minutes at most, else the session ends with
`error`, `realtime_failed`), told what was said lately. A session that moves to another node starts a new conversation
the same way.

## Utterances

With `realtime.transcribe` (the default), what each person says is transcribed, and with `deliver.webhooks` it goes to
your [webhook endpoints](webhooks.md) that select `voice.utterance`. The model has answered it already, so your app
should not:

```json
{"id": "evt_…", "type": "voice.utterance", "created": 1790000000,
 "data": {"session": "vs_…", "provider": "discord", "guildId": "…", "channelId": "…", "botUserId": "…",
          "speakerId": "<the Discord user who spoke>", "seq": 12, "text": "Can you add that to the list?", "language": "en",
          "seconds": 2.4, "startedAt": 1790000000000, "endedAt": 1790000002400, "ended": "silence", "costUsd": 0.000225,
          "addressed": true, "addressedBy": "always", "brain": "realtime", "subject": "user_42", "metadata": {"botId": 42}}}
```

`speakers` lists everyone whose audio is in it, when people spoke at once (`speakerId` is the first). `seq` numbers
them in the order their transcripts were made.

`voice.session.started` tells that the session connected (once), and `voice.session.ended` that it ended, with `reason`
(`requested`, `empty`, `idle`, `max_duration`, `budget`, `kicked`, `credentials`, `error`), `limit` and
`endUserReason` with `budget`, and the session's totals.

`voice.session.error` tells that the session's audio failed (`code: "media_crashed"`). Each session's audio is handled
apart from every other's, so a failure is its own. With `restarting: true` it reconnects at once, and the call goes on:
what the bot was saying ends (`voice.speech.ended`, `error`), and what someone was halfway through saying may be lost.
After 3 failures in 5 minutes it stops trying (`restarting: false`), and `voice.session.ended` (`error`) follows.

## Speaking

Each answer the model gives plays in the call as it is made, and is told in `voice.speech.started` (`speechId`,
`latencyMs` from asking the model to the first audio out, `startedAt`, and `turn.stagesMs` for the answer to a turn) and
`voice.speech.ended` (`speechId`, `reason`: `done`, `interrupted` or `error`; `by` with interrupted: `requested`,
`barge_in`, `end`, `superseded` or `budget`; `seconds` played and `costUsd`), each with `brain: "realtime"`.

`DELETE /v1/voice/sessions/{id}/speak` (`stopSpeaking`) stops what the bot is saying, and what it was about to. Any
node takes the request and passes it to the one holding the call; while the session moves between nodes, a 503 says to
retry (the SDKs do).

What the bot says is never heard back as speech (Discord does not send a bot its own audio, and the session ignores the
bot's user), and does not count as speech for `idleMinutes` or company for `emptySeconds`.

### Barge-in

With `bargeIn` (the default), a person talking over the bot (not the bot, not `ignoreUserIds`) stops its answer
(`by: "barge_in"`), so the bot does not talk over people. The model's answer is then cut where people stopped hearing
it, so its memory of the call matches what was heard. Someone on laptop speakers without headphones can send the bot's
own voice back into the call, so the bot checks first:

- After `minMs` (300) of their speech, it **pauses**. It keeps what it was saying.
- If they keep talking for `confirmMs` (1000) after the pause, it **stops**: echo stops when the bot does.
- The pause lasts at most `resumeMs` (3000). Then it stops if they are still talking, and **resumes** if not.
- With `endOfTurn: smart`, a turn that ends with less speech than words take (a cough, a click) resumes it at once.

Echo the guard rejects is dropped, not kept as someone's words. Pass `bargeIn: {minMs, confirmMs,
resumeMs}` to change the timing; `confirmMs: 0` stops at `minMs` with no pause and no echo check. Sessions show the
timing in use as `interruption`. Logs: `voice_barge_in_confirmed` and `voice_barge_in_echo_rejected` (`why`,
`pausedMs`).

## From a browser

A session with `provider: "browser"` is a call from a web page, with no Discord in it: for trying a voice bot out
(a test panel, a preview) through the same pipeline a Discord call takes: turns, barge-in, the realtime brain. Create
it from your server, and give the page only the answer's `browser.url` and `browser.token`, never your API key:

```ts
const session = await fetch("https://run.camelai.com/v1/voice/sessions", {
  method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ provider: "browser", deliver: { agent: agentId, webhooks: false }, metadata: { preview: true } }),
}).then(response => response.json());
// In the page:
const socket = new WebSocket(`${session.browser.url}?token=${encodeURIComponent(session.browser.token)}`);
socket.binaryType = "arraybuffer";
```

A browser session needs no `discord`; its socket gets every utterance itself. The token opens the socket for 10
minutes; `POST /v1/voice/sessions/{id}/browser-token` makes another (a page that reloads). One socket is open at a
time, and closing it hangs up: the call is then empty, and `emptySeconds` ends the session.

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
| camelRun → page | `{"type":"utterance",…}` | Each utterance transcribed: `speakerId`, `text`, `startedAt`, `endedAt`, `brain` |
| camelRun → page | `{"type":"speech",…}` | `state: "started"` (`speechId`, `latencyMs`, `startedAt`, `turn`) and `state: "ended"` (`reason`, `by`, `seconds`) |

The socket may reach any node: one that does not hold the session relays it to the one that does.

## Latency

Each answer's first audio is timed: `voice_turn_latency` with `Path=realtime`, in ms from the end of speech
(`turnCommit`; `ttsFirstAudio`, the model's first audio; `firstPacket`, its first audio out), plus `VoiceRealtimeMs`
(commit to the model's first audio) and `VoicePlayoutMs`. When the session is let go, `voice_realtime_stats` counts its
turns, answers, ask_agent and stay_silent calls, barge-ins and speculation taken back.

## Cost

A session is billed by the tokens its model uses, at the provider's list price on the platform's key: each answer is a
`usage.recorded` with `kind: "speech"`, the model as `model`, its tokens in `input` and `output` (`cacheRead` for cached
ones) and `audioSeconds` of audio made, with the session's `subject` and `context.voiceSession`. Each answer bills the
conversation so far again (mostly cached, at a tenth or less of the price), so a minute costs more as a call goes on. A
conversational minute (people talk half of it, the bot a third) is about $0.05 on `gpt-realtime-2.1`, $0.02 on
`gpt-realtime-2.1-mini` and $0.02-0.035 on `gemini-3.8-live` (measured). What people say is transcribed (`transcribe`)
at the [transcription price](../pricing.md), as `kind: "transcription"`. `ask_agent`'s runs are billed as any run. On
your own key the provider bills you directly; the usage record still carries the cost. Holding the call itself costs
nothing.

A session starts only when the account may spend (402 `SPEND_LIMIT` otherwise). An account that runs out during a call
ends it: `reason: "budget"`, `limit: "tenant"`. With end-user credits on, a subject with nothing left is refused at the
start (402 `END_USER_CREDIT`), each answer holds $0.05 of the subject's credit before it is asked for and settles at
what it cost, and running out ends the session (`limit: "end_user"`).

## Privacy and your duties

- People in the call must know they are being transcribed. camelRun cannot post in Discord, so your app posts
  `notice.text` in the voice channel's chat when it joins, from code your bot's authors cannot turn off. Telling them
  is your app's job: camelRun cannot check it.
- Audio is never stored: it streams to the realtime provider as it is spoken, and is dropped. Transcripts are not kept
  beyond delivery (an undelivered webhook event is retried for up to 3 days; an agent keeps what `ask_agent` asked in
  its history). Logs carry ids, lengths and counts, never audio or text.
- Webhook events are delivered at least once: dedupe them by `id`.
- Discord's end-to-end encryption (DAVE) is checked: a member of the call's encryption group that Discord's voice
  server never named drops the connection, which joins again with a new group.
- The call's audio goes to the realtime provider (OpenAI or Google) as it is spoken, and the model's answers come back
  as audio; neither is stored by camelRun, and the provider keeps them under its API data policy. What was said lately
  is held in memory (to brief a new connection), never written.
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
| Turn | 300 ms to 30 s |
| Reconnect wait for new credentials | 15 s |
