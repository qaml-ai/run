import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyAgentList } from "../src/legacy-agent-list.ts";

test("legacy agent listing keeps tenant scope, IDs and the original cursor", async () => {
  const first = `client_${"1".repeat(40)}`;
  const records = [first, `client_${"2".repeat(40)}`].map(id => ({
    id, key: id, name: "Builder", type: "agent", model: "example/model", config_hash: "fixture",
    application_metadata: { type: "builder" }, workspace: null, parent: null, expires_at: null,
    resume_failures: 0, last_active_at: null, last_error_at: null, served: false,
  }));
  const sql = {
    async query<Row>(query: string, values: unknown[]) {
      assert.match(query, /a\.tenant = \$1/);
      assert.match(query, /not a\.revoked/);
      assert.match(query, /a\.header->'run' is null/);
      assert.match(query, /order by a\.id limit 2/);
      assert.equal(values[0], "test-tenant");
      assert.equal(values[2], '{"type":"builder"}');
      return { rows: records as unknown as Row[], rowCount: records.length };
    },
  };
  const request = new Request("https://agents.camelai.dev/v1/agents?limit=1&metadata.type=builder");
  await assert.rejects(legacyAgentList(request, sql, null), { status: 401 });
  const response = await legacyAgentList(request, sql, { tenantId: "test-tenant", kind: "oauth" });
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("cache-control"), "no-store");
  assert.equal(Buffer.from(response!.headers.get("x-next-cursor")!, "base64url").toString(), first);
  assert.deepEqual((await response!.json() as { id: string }[]).map(agent => agent.id), [first]);
});
