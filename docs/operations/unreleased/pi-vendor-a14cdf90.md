### Pi vendored at main a14cdf90f0a7

Pi's Session now stores commits in groups and makes no storage reads in a normal run. Nothing changes in the API. An
agent's Pi steps no longer wait for one another's database round trip, and a run reads less from Postgres.

The Postgres storage implements Pi's new `Storage.commit(batches, receive, context)`, each batch in its own transaction
as before. The host's journal writes now go through Pi's Session while an agent is open, since Pi keeps a conversation's
newest entry and a run's context from its own commits: a failed journal write now fails Pi's Session too, and the agent
is given up and reloaded, as after a failed Pi commit.

No stored format moved: this deploy can be rolled back. Models and prices are unchanged.
