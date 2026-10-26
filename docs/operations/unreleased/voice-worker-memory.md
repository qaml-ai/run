### Voice media workers: memory counted once, and a memory kill says what grew; jemalloc in the image

A media worker's memory check (`AGENT_VOICE_WORKER_MAX_MB`, 256) added `arrayBuffers` to `external`, which already
includes it, so every Buffer counted twice. `arrayBuffers` also counts Buffers the worker transferred to another
thread for as long as that thread keeps them. Workers were ended for memory they did not hold: 58 times since
2026-10-20, all in long, busy calls. The check is now heap plus external. The worker's heartbeat carries its memory
split (heap, external, ArrayBuffers, the Opus heap and its codecs) and, for each session, counts of what it holds:
streams, SSRCs, packets held, playbacks. `voice_worker_crashed` logs that split (`memory`) when a worker is ended for
its memory.

The image preloads jemalloc for the runtime's node process. With glibc, memory freed by an ended worker thread stays
in its arena: 32 media worker kills left a node at 713 MB, against 80 MB before them; with jemalloc it was 144 MB,
against 100 MB.
