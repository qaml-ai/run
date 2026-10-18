# Turn-taking fixtures

The four WAV clips (16 kHz mono, 16-bit) are from pipecat's Smart Turn test set,
[pipecat-ai/smart-turn-data-v3.1-test](https://huggingface.co/datasets/pipecat-ai/smart-turn-data-v3.1-test),
licensed [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) by Daily and its contributors (Liva AI,
Midcentury, MundoAI). Named `<language>-<c|i>-<id>.wav`: `c` ends a turn (the speaker is done), `i` stops mid-thought;
`<id>` is the first 8 characters of the clip's id there. Unchanged but for the file format.

`reference.json` holds, for each, what pipecat's own inference computes (Hugging Face's WhisperFeatureExtractor, then
the model on onnxruntime): Smart Turn v3.2's probability, the features' mean and 200 of their values, for
`tests/voice-turns.test.ts` to compare with. `scripts/voice-turns-dataset.py` makes a larger labelled set the same way,
for `scripts/voice-turns-eval.ts`.
