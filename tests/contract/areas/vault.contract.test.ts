import { contractTest, runtime } from "../support.ts";
import { vaultApiCase } from "../../vault-cases.ts";
contractTest("keys", "tests/vault-api.test.ts", "vault API: write-only values, rotation, scopes and deletion", t => vaultApiCase(t, runtime));
