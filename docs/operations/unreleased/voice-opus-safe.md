### Voice: Opus without opusscript's wrapper, which corrupted memory and crashed the node

opusscript 0.1.1's JavaScript wrapper views each codec's PCM buffer at twice its address and size, so it wrote over
other codecs' memory, and its views detached when the WebAssembly memory grew. A busy node's codecs then trapped
("memory access out of bounds"), and one trap, in a decoder freed from a silence timer, ended the process. The runtime
now drives opusscript's libopus build itself (`src/opus.ts`): buffers allocated whole and viewed afresh on each call,
`delete` idempotent and never throwing, a codec that traps broken on its own (its module retired for new codecs). A
speaker whose decoder breaks has their utterance cut there and gets a new decoder; nothing in a speaker's audio path
or the silence timer can throw to the process.
