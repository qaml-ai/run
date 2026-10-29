### Voice sessions say words and play audio

A voice session's bot can now speak from your app, not only in answer to people:

- `POST /v1/voice/sessions/{id}/say` says given words, word for word, in the call's voice (text to speech, billed as
  `POST /v1/speech`), and `POST …/prompt` has the realtime model speak up on its own. Both wait their turn behind
  what the bot is saying, or cut it off with `interrupt`. Their `voice.speech.*` events carry `source: "say"`.
- `POST …/audio` plays MP3, Ogg Opus or WAV files and streams, by https URL or as an upload, from a queue;
  `GET`/`PATCH …/audio` read and control it (pause, resume, skip, stop, volume). The bot's speech holds the music, and
  barge-in leaves it be. New webhook events: `voice.audio.started` and `voice.audio.ended`. Sessions count `tracks`
  and `playedSeconds`. Playing audio is not billed.

The TypeScript and Python clients have `say`, `prompt`, `play`, `audio` and `controlAudio` (`control_audio`).
Implementation: `src/voice/jukebox.ts`, `src/voice/audio-decode.ts` (minimp3, Apache-2.0, for MP3), and the brain's
`say`/`prompt` in `src/voice/realtime/brain.ts`. Migration `097_voice_audio.sql`.
