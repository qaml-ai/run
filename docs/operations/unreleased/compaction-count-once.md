### Compaction counts the system prompt once, and never summarizes nothing

- When to compact counted the system prompt twice once the provider had reported usage, since its report already
  includes it. Compaction then started about one system prompt's worth of tokens early.
- A compaction whose cut kept every message still made a summary call and wrote an empty summary. That changed the
  start of the context and made the provider write it all to its cache again. It is now skipped.
