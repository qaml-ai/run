### ElevenLabs calls past 10 minutes

- ElevenLabs Agents conversations now last up to 30 minutes, and a conversation that reaches its limit ("Max call
  duration exceeded") is replaced by a fresh one, briefed with what was said, instead of ending the voice session with
  `error`. Calls on ElevenLabs voices longer than 10 minutes used to end. The runtime creates a new agent per
  credential (`camelRun realtime voice v3`) on first use; the earlier `v2` agents are no longer used and can be deleted
  from the ElevenLabs account. See `docs/guides/voice-calls.md` for the realtime brain.
