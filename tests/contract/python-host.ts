import { test } from "node:test";
import { createFixture, type FixtureOptions } from "./fixture.ts";

// Python owns its scripted provider. Only process/database setup belongs here.
const options = JSON.parse(process.env.CONTRACT_FIXTURE_OPTIONS!) as FixtureOptions;
test("Python contract fixture host", { timeout: 180_000 }, async t => {
  const stopped = new Promise<void>(resolve => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  const fixture = await createFixture(t, options);
  console.log(`@@CONTRACT_HOST@@${JSON.stringify({ base: fixture.base })}`);
  await stopped;
});
