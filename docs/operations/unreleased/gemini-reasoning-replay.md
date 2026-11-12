### `camelrun/strong`: a history whose Gemini reasoning another provider signed is sent again without it

OpenRouter's Gemini endpoints accept encrypted reasoning only from the provider that produced it:

- Google AI Studio signs every flex call, and Vertex refuses those signatures;
- Vertex signs most default-tier calls, and AI Studio refuses those;
- the refusal is a 400, "Gemini models require OpenRouter reasoning details to be preserved".

So `camelrun/strong`'s fallback from flex to the default tier failed every time, and a default-tier history that crossed the two providers failed too.

On that 400, the same member is now asked again, once, with the history's encrypted reasoning dropped. Each earlier turn keeps its thought text, tool calls and results. The rest of the chain also uses the history without that reasoning. The retry is logged as `model_reasoning_replay_dropped`. This applies to both backends.

After that first refusal, the same agent drops the encrypted reasoning before the request for all its later calls, so it doesn't pay a refused request (a whole prompt upload) on every call until compaction. This lasts for the agent instance's life; after a restart, the first refusal happens once more. On Node, the next member of the chain now gets the stripped history too, as it already did on Workers.
