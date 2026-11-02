### Relace no longer serves DeepSeek V4.1 Flash 1017

`openrouter/deepseek/deepseek-v4.1-flash-1017` and `:nitro` now send `provider.ignore: ["inference-net", "wafer", "relace"]`.
Relace drops a tool call's `name` argument: overnight on 2026-11-02, camel-builder's `create_bot` calls served by Relace
arrived without `name`, and each conversation that then looped on the error had started on a Relace response.
