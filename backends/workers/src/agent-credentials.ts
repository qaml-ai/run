import { ApiError, agentToken } from "./api-contract.ts";
import type { ControlEnv, DirectoryEntry } from "./control.ts";
import { transaction } from "./postgres.ts";

/** Change only the credential generation under the same lock as configuration. */
export async function rotateAgentCredentials(env: ControlEnv, entry: DirectoryEntry) {
  const updated = await transaction(env, async sql => {
    await sql.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [entry.id]);
    const result = await sql.query(
      "update agents set header=jsonb_set(header::jsonb,'{tokenVersion}',to_jsonb($3::text))::json where id=$1 and tenant=$2 and not revoked returning header",
      [entry.id, entry.tenantId, crypto.randomUUID()],
    );
    if (!result.rows.length) throw new ApiError(404, "Unknown agent", "AGENT_NOT_FOUND");
    return result.rows[0].header as DirectoryEntry;
  });
  const retired = await env.AGENTS.getByName(entry.id).fetch(new Request("https://agent/credentials/rotate", { method: "POST" }));
  if (!retired.ok) throw new ApiError(retired.status, "Agent connection retirement failed", "ROTATION_FAILED");
  return { id: entry.id, token: await agentToken(env.API_TOKEN, entry.id, updated.tokenVersion), expiresAt: updated.expiresAt };
}
