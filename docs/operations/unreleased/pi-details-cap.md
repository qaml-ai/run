### Smaller stored tool results

Direct JSON tool results no longer repeat their content in `details`. Other direct-tool details over 16 KiB of
JSON, and js_exec details over 32 KiB, become `{ truncated: true, path? }` in events and history. The full JSON is
saved beside tool output in `tool-results/` when a writable workspace is available and it fits the 700 KiB
file-write limit; otherwise it is dropped. Values past 700 KiB log `tool_details_dropped` with the agent, tool
and byte count only. Model-visible content, input-required markers, and `final_output` results are unchanged.

User-entry deduplication is off by default. `AGENT_PI_DEDUPE_USER_ENTRIES=true` stores content only in the model
message; readers accept both formats. Leave it off until this reader is deployed everywhere and older releases
are no longer rollback targets: older readers require content in `data.message`.
