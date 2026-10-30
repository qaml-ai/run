### Live MP3 streams that start mid-frame play

`POST /v1/voice/sessions/{id}/audio` refused a live MP3 stream whose first bytes were the middle of a frame, as
`AUDIO_UNSUPPORTED`. Such a stream is now told by two MP3 frames in a row within its first 4 KB, and plays from the
first whole frame. HTML pages and other non-audio are still refused.
