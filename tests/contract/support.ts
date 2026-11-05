import { test, type TestContext } from "node:test";
import { createFixture, type ContractFixture, type FixtureOptions } from "./fixture.ts";
import { evidence } from "./evidence.ts";
export * from "./http.ts";
export { createFixture as createContractFixture } from "./fixture.ts";

export function contractTest(area: string, source: string, name: string,
  body: (t: TestContext, fixture: ContractFixture) => Promise<void> | void, options: FixtureOptions = {}) {
  test(`[${area}] ${source} :: ${name}`, { timeout: Number(process.env.CONTRACT_TIMEOUT_MS ?? 90_000) }, async t => evidence.run({ backend: null }, async () => {
    let fixture: ContractFixture;
    try { fixture = await createFixture(t, options); }
    catch (error) { throw new Error(`Fixture setup failed: ${(error as Error).message}`, { cause: error }); }
    try { await body(t, fixture); }
    finally { t.diagnostic(`contract-backend:${JSON.stringify({ name: t.name, backend: evidence.getStore()!.backend ?? "sdk-unit" })}`); }
  }));
}

/** Adapter for copied SDK cases; assertions and SDK calls stay unchanged. */
export async function runtime(t: TestContext, respond: (body: any, index: number) => object, env: Record<string, string> = {}, tenants?: object) {
  return createFixture(t, { respond, env, tenants });
}

export function sdkTest(source: string) {
  return (name: string, body: (t: TestContext) => Promise<void> | void) => test(`[sdk] ${source} :: ${name}`, { timeout: 90_000 }, async t => evidence.run({ backend: null }, async () => {
    try { await body(t); }
    finally { t.diagnostic(`contract-backend:${JSON.stringify({ name: t.name, backend: evidence.getStore()!.backend ?? "sdk-unit" })}`); }
  }));
}
