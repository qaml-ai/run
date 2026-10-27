### Smaller stored tool results

Direct JSON tool results no longer repeat their content in `details`. Other direct-tool details over 16 KiB of
JSON, and js_exec details over 32 KiB, become `{ truncated: true, path? }` in events and history. The full JSON is
saved beside tool output in `tool-results/` when a writable workspace is available and it fits the 700 KiB
file-write limit; otherwise it is dropped. Model-visible content, input-required markers, and `final_output`
results are unchanged. User prompts are stored once per Pi entry; history still includes their content and metadata.
