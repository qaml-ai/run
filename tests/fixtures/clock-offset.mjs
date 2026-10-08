// Preloaded (NODE_OPTIONS=--import) into a runtime node whose clock is off by AGENT_TEST_CLOCK_OFFSET_MS: Date.now reads
// that far from the host's clock, as a node with a skewed clock would.
const offset = Number(process.env.AGENT_TEST_CLOCK_OFFSET_MS ?? 0);
const now = Date.now;
Date.now = () => now() + offset;
