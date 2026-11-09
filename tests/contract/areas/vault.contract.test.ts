import { contractTest, runtime } from "../support.ts";
import { vaultApiCase, vaultHostRulesCase } from "../../vault-cases.ts";
contractTest("keys", "tests/vault-api.test.ts", "vault API: write-only values, rotation, scopes and deletion", t => vaultApiCase(t, runtime));
contractTest("keys", "tests/vault-api.test.ts", "vault and network policies allow exact private-suffix hosts and refuse suffix wildcards", t => vaultHostRulesCase(t, runtime));
