### Azure DeepSeek V4.1 Flash, over Chat Completions

Azure DeepSeek V4.1 Flash is available as `azure/deepseek-v4.1-flash` when the platform maps it to its deployment, for example `deepseek-v4.1-flash=DeepSeek-V4.1-Flash` in `AGENT_AZURE_OPENAI_MODELS`.

It uses Azure v1 Chat Completions with tools, reasoning, images and cached input. Its context window is 1,048,576 tokens, including output; the default maximum reply is 131,072 tokens. Azure Global prices per million tokens are $0.30 input, $1.20 output and $0.006 cached input, with no cache-write charge. The Azure version is 2026-09-10 (preview), not OpenRouter's 2026-10-17 snapshot. Calls and billing use the same platform credential path as Azure's Responses models.
