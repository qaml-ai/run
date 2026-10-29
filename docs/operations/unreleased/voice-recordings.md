### Voice: record a call

`POST /v1/voice/sessions/{id}/recording` records a voice session's call as Ogg Opus: one mixed file (mono, 24 kHz) or a
file per speaker (`tracks: "speakers"`, the bot's own speech among them, all lined up from the recording's start), until
`DELETE …/recording`, `maxMinutes` (default 60, at most 240), `maxBytes` (default 25 MiB, at most 100 MiB) or the
session's end. The answer has a `notice` for the voice channel's chat. Its files are kept `retentionHours` (default 24,
at most 720), at `GET /v1/voice/recordings/{id}/files/{name}`, and `voice.recording.ended` says when they are ready
(add it to an endpoint's events to get it). While it records, the owning node writes the audio to object storage in
chunks (`recordings/<tenant>/<id>/`), so a session handed to another node goes on recording into the same recording.
Audio is stored only while a call is recorded. The TypeScript client has `voice.record`, `stopRecording`, `recording`,
`recordingFile` and `deleteRecording`. Migration `096_voice_recordings.sql`. Logs: `voice_recording_created`,
`voice_recording_started`, `voice_recording_ended`, `voice_recording_failed`.
