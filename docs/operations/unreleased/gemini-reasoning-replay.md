### `camelrun/strong`: a history whose Gemini reasoning another provider signed is sent again without it

OpenRouter's Gemini endpoints accept encrypted reasoning only from the provider that produced it:

- Google AI Studio signs every flex call, and Vertex refuses those signatures;
- Vertex signs most default-tier calls, and AI Studio refuses those;
- the refusal is a 400, "Gemini models require OpenRouter reasoning details to be preserved".

So `camelrun/strong`'s fallback from flex to the default tier failed every time, and a default-tier history that crossed the two providers failed too.

On that 400, the same member is now asked again, once, with the history's encrypted reasoning dropped. Each earlier turn keeps its thought text, tool calls and results. The rest of the chain also uses the history without that reasoning. The retry is logged as `model_reasoning_replay_dropped`. This applies to both backends.

After a refusal, the agent remembers when it happened. Its later **Gemini** calls drop the encrypted reasoning of turns written before that time, before sending, so they don't pay the refused request (a whole prompt upload) again until compaction:
- turns written since keep their reasoning, and a new refusal moves the time forward;
- calls to other models, including Claude or GPT through OpenRouter, are unaffected;
- the memory clears when the agent's model changes or the instance restarts.

On both backends, only Gemini members of a chain get the trimmed history.
