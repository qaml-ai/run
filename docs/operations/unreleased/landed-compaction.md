### Messages that land without a turn are compacted

Pi checks its compaction threshold only as it prepares a model request, so an agent that kept receiving messages without
running a turn (a credit- or spend-stopped agent's sub-agent notices, notices past the wake cap) grew its context without
bound. After such a message lands, the host now applies the same check, and past the threshold starts Pi's own
compaction (`Conversation.compact()`), unless one is already running. The write never waits for the summary. A turn
that starts meanwhile waits for that compaction and starts on its summary, instead of compacting the same context again.
The model sees the change only as the summary text. Summary usage between runs is reported as the agent's background
work (`background: true`) and billed as such.
