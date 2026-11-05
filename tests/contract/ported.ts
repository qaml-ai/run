import { test, type TestContext, type TestOptions } from "node:test";
import { evidence } from "./evidence.ts";
import { describeCase } from "./support.ts";

/** Keep original HTTP test setup and assertions, including its local fake-provider lifecycle. */
export function portedTest(area: string, source: string) {
  return (name: string, optionsOrBody: TestOptions | ((t: TestContext) => Promise<void> | void), maybeBody?: (t: TestContext) => Promise<void> | void) => {
    if (describeCase(area, source, name)) return;
    const options = typeof optionsOrBody === "function" ? {} : optionsOrBody;
    const body = typeof optionsOrBody === "function" ? optionsOrBody : maybeBody!;
    test(`[${area}] ${source} :: ${name}`, { timeout: 90_000, ...options }, async t => evidence.run({ backend: null }, async () => {
      try { await body(t); }
      finally { t.diagnostic(`contract-backend:${JSON.stringify({ name: t.name, backend: evidence.getStore()!.backend ?? "sdk-unit" })}`); }
    }));
  };
}
