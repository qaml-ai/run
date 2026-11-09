import { contractTest } from "../support.ts";
import { applicationMetadataCase, invalidMetadataCase, queuedMetadataCase } from "../../application-metadata-cases.ts";
contractTest("agents", "tests/application-metadata.test.ts", "tenant application metadata is bounded, replaceable and queryable", async (_t, fixture) => {
  await applicationMetadataCase(fixture);
});

contractTest('agents', 'tests/application-metadata.test.ts', 'metadata validates UTF-8 size, object shape and unique nonempty filter keys', async (_t, fixture) => {
  await invalidMetadataCase(fixture);
});


contractTest("agents", "tests/application-metadata.test.ts", "an omitted metadata upsert preserves an earlier queued update", async (_t, fixture) => {
  await queuedMetadataCase(fixture, reply => fixture.setModel(reply));
});
