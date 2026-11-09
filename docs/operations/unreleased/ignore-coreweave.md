### CoreWeave no longer serves DeepSeek V4.1 Flash 1017

`openrouter/deepseek/deepseek-v4.1-flash-1017` and `:nitro` now send
`provider.ignore: ["inference-net", "wafer", "relace", "coreweave"]`, on both backends. CoreWeave's responses ended
mid-stream with "Provider finish_reason: error": on 2026-11-09 all 24 such model errors of camel-builder in 24 hours
were CoreWeave's (20 in about 1,020 responses between 12:00 and 14:00 UTC), and no other host had one. It is a filter
(no `order` or `sort`), so OpenRouter still balances load among every other host. `:vetted` and `:morph` never
included CoreWeave and are unchanged, as is DeepSeek V4.1 Flash (not 1017), whose five listed hosts still include it.
