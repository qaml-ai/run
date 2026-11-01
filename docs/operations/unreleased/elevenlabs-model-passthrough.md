### ElevenLabs realtime models

ElevenLabs voice sessions accept any model ElevenLabs Agents offers, with `gemini-3.1-flash-lite` still the default.
Each model uses its own agent; existing model agents are reused. Refused models produce an error naming the model.
Other models use `AGENT_PRICE_ELEVENLABS_OTHER_LLM_MINUTE_USD`, default `0.05` USD per minute, plus the configured Agents rate.
