import { test, type TestContext } from "node:test";
import { createFixture, type ContractFixture, type FixtureOptions } from "./fixture.ts";
import { evidence } from "./evidence.ts";
export * from "./http.ts";
export { createFixture as createContractFixture } from "./fixture.ts";

export function describeCase(area: string, source: string, name: string) {
  if (process.env.CONTRACT_LIST !== "1") return false;
  console.log(`@@CONTRACT_CASE@@${JSON.stringify({ area, source, name, file: process.env.CONTRACT_FILE })}`);
  return true;
}

export function contractTest(area: string, source: string, name: string,
  body: (t: TestContext, fixture: ContractFixture) => Promise<void> | void, options: FixtureOptions = {}) {
  if (describeCase(area, source, name)) return;
  test(`[${area}] ${source} :: ${name}`, { timeout: Number(process.env.CONTRACT_TIMEOUT_MS ?? 90_000) }, async t => evidence.run({ backend: null }, async () => {
    // Copied cases with a one-argument callback start their own fixture after
    // constructing local providers. Do not start an unused second runtime.
    let fixture: ContractFixture | undefined;
    try { if (body.length > 1) fixture = await createFixture(t, options); }
    catch (error) { throw new Error(`Fixture setup failed: ${(error as Error).message}`, { cause: error }); }
    try { await body(t, fixture!); }
    finally { t.diagnostic(`contract-backend:${JSON.stringify({ name: t.name, backend: evidence.getStore()!.backend ?? "sdk-unit" })}`); }
  }));
}

/** Adapter for copied SDK cases; assertions and SDK calls stay unchanged. */
export async function runtime(t: import("./http.ts").T, respond: (body: any, index: number) => object, env: Record<string, string> = {}, tenants?: object) {
  return createFixture(t, { respond, env, tenants });
}

export function sdkTest(source: string) {
  return (name: string, body: (t: TestContext) => Promise<void> | void) => {
    if (describeCase("sdk", source, name)) return;
    return test(`[sdk] ${source} :: ${name}`, { timeout: 90_000 }, async t => evidence.run({ backend: null }, async () => {
    try { await body(t); }
    finally { t.diagnostic(`contract-backend:${JSON.stringify({ name: t.name, backend: evidence.getStore()!.backend ?? "sdk-unit" })}`); }
    }));
  };
}
