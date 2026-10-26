### GPT-6.1 Terra

The model catalog includes `openai/gpt-6.1-terra`, `azure/gpt-6.1-terra` and
`openrouter/openai/gpt-6.1-terra`, with GPT-6.1 Sol's context window on each provider. Base prices
per million tokens are $1 input, $5 output and $0.05 cache reads. Cache writes
are $1.25. Above 272,000 input tokens, rates are $2 input, $7.50 output,
$0.10 cache reads and $2.50 cache writes.

The base prices come from OpenRouter's 2026-10-26 model list, and OpenAI and
Azure use them too. Other capabilities are assumed to match each
provider's GPT-6.1 Sol entry: Responses API, text and image input, 128,000 maximum
output tokens, and low, medium, high, xhigh and max reasoning. Cache writes and
the long-context tier are assumed to cost half Sol's rates at the same threshold.
Tool-call streaming is unmeasured. Azure accepts Terra in the configured models
map, but requires a deployment before it can be used; none is added by this change.
