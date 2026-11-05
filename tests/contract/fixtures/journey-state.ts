import { Accounts } from "../../../src/accounts.ts";
import { Tenants } from "../../../src/tenants.ts";
import type { Db } from "../../../src/db.ts";

/** Seed only pre-existing signup state; tested HTTP operations emit their own events. */
export async function seedJourneyAccount(db: Db, input: { login: string; githubId: number; startingGrant: number; accountRef?: string }) {
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db,
    pricing: { startingGrant: input.startingGrant } as never });
  const tenant = await accounts.tenantForGithub({ login: input.login, id: input.githubId, createdAt: Date.now() - 365 * 86_400_000 }, { minAccountAgeMs: 0 });
  if (input.accountRef) await db.query("insert into journey_accounts(tenant,account_ref,since_signup,consent,created_at) values($1,$2,true,'granted',$3)", [tenant, input.accountRef, Date.now()]);
  const { token } = await accounts.createToken(tenant, "script");
  return { tenant, token };
}
