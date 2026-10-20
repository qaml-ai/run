### Exact voice ID checks

- `GET /v1/voices/{provider}/{id}` and TypeScript/Python `voices.get(provider, id)` check a saved exact voice ID and return voice metadata, `usable`, and a reason. ElevenLabs uses the same keys as search and reads account copies and exact shared-library metadata without importing a voice. Grok, OpenAI, and Gemini use the fixed voice lists.
