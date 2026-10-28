### History is read from Pi storage by ordinal; the history index writer is gone

History pages, the full history, account export, forks and a context reset's kept messages now read an agent's messages
from Pi storage by ordinal (the columns #481 added), on whichever node serves the request, with every read bounded in bytes
before it reads. Agents no longer write history index chunks: the index writer, the stop-time flush (`historyFlushMs`),
the running agent's history tail, page forwarding to the owning node and the journal backlog read are deleted. A fork's
copied history is stored in the fork's own Pi storage as archive entries instead of index chunks. History from before
an agent's journal (retired host transcripts, older forks) is still read from the existing index chunks until it moves
into Pi storage. An agent not yet placed is placed at its first history read. See `docs/operations/pi-durable.md`.
