import { test } from "node:test";
import { runtime } from "./runtime-server.ts";
import { applicationMetadataCase, invalidMetadataCase, queuedMetadataCase } from "./application-metadata-cases.ts";
test("tenant application metadata is bounded, replaceable and queryable", async t => {
  await applicationMetadataCase(await runtime(t, () => ({ role: "assistant", content: "Done" })));
});

test('metadata validates UTF-8 size, object shape and unique nonempty filter keys', async t => {
  await invalidMetadataCase(await runtime(t, () => ({ role: 'assistant', content: 'Done' })));
});


test("an omitted metadata upsert preserves an earlier queued update", async t => {
  let reply = () => ({ role: "assistant", content: "Done" } as object);
  const r = await runtime(t, () => reply());
  await queuedMetadataCase(r, next => { reply = next; });
});
