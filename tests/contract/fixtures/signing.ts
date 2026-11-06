import { Accounts } from "../../../src/accounts.ts";
import type { Db } from "../../../src/db.ts";
import { RuntimeSigner } from "../../../src/identity.ts";
import { Tenants } from "../../../src/tenants.ts";

/** Test grants use the backend's real signing rows and the shared token format. */
export function fixtureSigner(db: Db, secretsKey: string, issuer: string) {
  const accounts = new Accounts({ db, secretsKey, tenants: new Tenants({ read: async () => '{"tenants":{}}' }) });
  return new RuntimeSigner({ db, accounts, issuer });
}
