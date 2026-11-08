import { fileURLToPath } from "node:url";
import { startFixture } from "../../backends/workers/test/fixture.ts";

// Compile and initialize once before files compete for the cold dependency
// tree. This fixture has no agent state and is never reused by a test.
const started = performance.now();
const fixture = await startFixture({
  entrypoint: fileURLToPath(new URL("../../backends/workers/test/contract-entry.ts", import.meta.url)),
});
await fixture.stop();
console.log(`Workers runtime prepared in ${Math.round(performance.now() - started)}ms`);
