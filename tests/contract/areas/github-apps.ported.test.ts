import { portedTest } from "../ported.ts";
import { runtime } from "../support.ts";
import { cases } from "../../github-apps-cases.ts";

/** GitHub Apps on either backend: the cases tests/github-apps.test.ts runs on Node, against the same fake GitHub. */
const test = portedTest("keys", "tests/github-apps.test.ts");

for (const [name, body] of Object.entries(cases)) {
  test(`through the API: ${name}`, t => body(t, async (t, respond, env) => {
    const r = await runtime(t, respond, env);
    return Object.assign(r, { query: (text: string) => r.channelQuery(text) });
  }));
}
