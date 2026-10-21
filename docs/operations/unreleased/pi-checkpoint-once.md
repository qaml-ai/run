### Pi sessions checkpoint their context only when it changes

The host reassigns its view of the conversation around every run. The Pi adapter used to treat each
reassignment as a change and rewrite the whole working context into the journal before the next run,
so journal size grew with the square of a session's turns (one production chat had 24,806 copied
context records after 15 responses). A reassignment that is equal as the model sees it is now a no-op;
system changes, retractions, resets and compaction still checkpoint as before.
