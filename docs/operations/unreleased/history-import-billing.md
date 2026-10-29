### Imported history is not charged again

Creating an agent with `initialMessages` charged each imported assistant message's original usage again: a usage receipt, agent spend and a `usage.recorded` event per message. An import is now free. Imported messages keep their usage for context accounting, and new model responses are charged as before.
