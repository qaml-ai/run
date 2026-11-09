import { contractTest } from "../support.ts";
import { applicationMetadataCase, queuedMetadataCase } from "../../application-metadata-cases.ts";
contractTest("agents", "tests/application-metadata.test.ts", "tenant application metadata is bounded, replaceable and queryable", async (_t, fixture) => {
  await applicationMetadataCase(fixture);
});


contractTest("agents", "tests/application-metadata.test.ts", "an omitted metadata upsert preserves an earlier queued update", async (_t, fixture) => {
  await queuedMetadataCase(fixture, reply => fixture.setModel(reply));
});
