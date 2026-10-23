import { test } from "node:test";
import assert from "node:assert/strict";
import { adminMcp, mcpSignupAttribution } from "../src/admin-mcp.ts";
import { adminAcquisition } from "../src/admin-acquisition.ts";
import { mcpClientKind, mcpGrantKind } from "../src/mcp-client-kind.ts";
import { OAuth } from "../src/oauth.ts";
import type { Db } from "../src/db.ts";
import { testDatabase } from "./database.ts";

const NOW = Date.parse("2026-03-20T15:00:00Z"), DAY = 86_400_000;
const registration = (name: string, redirects: string[]) => `mcp_${Buffer.from(JSON.stringify({ n: name, r: redirects, m: "none" })).toString("base64url")}.${"x".repeat(32)}`;

test("MCP kinds use exact registration names or parsed callback hosts", () => {
  for (const host of ["chatgpt.com", "chat.openai.com"]) assert.equal(mcpClientKind("An MCP client", [`https://${host}/connector/oauth/callback`]), "chatgpt");
  assert.equal(mcpClientKind(" Codex ", ["http://127.0.0.1:12345/callback"]), "codex");
  assert.equal(mcpClientKind("Claude Code", []), "claude");
  assert.equal(mcpClientKind("", ["https://claude.ai/api/mcp/auth_callback"]), "claude");
  for (const uri of ["broken", "https://chatgpt.com.evil.test/cb", "https://chatgpt.com@evil.test/cb", "https://evil.test/chatgpt.com", "http://chatgpt.com/cb"]) {
    assert.equal(mcpClientKind("My ChatGPT tool", [uri]), "other");
  }
  assert.equal(mcpClientKind("Browser", ["http://localhost:1234/callback"]), "other", "a loopback URI alone is not Codex");
  assert.equal(mcpClientKind("Claude", ["https://chatgpt.com/cb"]), "chatgpt", "callback evidence wins over a name");
  assert.equal(mcpGrantKind("An MCP client", registration("An MCP client", ["https://chatgpt.com/cb"])), "chatgpt");
  assert.equal(mcpGrantKind("Codex", "legacy-client"), "codex");
  assert.equal(mcpGrantKind("Unknown", `mcp_bm90LWpzb24.${"x".repeat(32)}`), "other");
});

test("registration ids from OAuth preserve callback metadata for reports", () => {
  const oauth = new OAuth({ secret: "test-mcp-report-registration-secret" } as ConstructorParameters<typeof OAuth>[0]);
  const client = oauth.register({ client_name: "An MCP client", redirect_uris: ["https://chatgpt.com/connector/oauth/test"], token_endpoint_auth_method: "none" });
  assert.equal(mcpGrantKind(client.client_name, client.client_id), "chatgpt");
});

async function fixture() {
  const { db } = await testDatabase();
  const signup = NOW - 2 * DAY;
  for (const [id, email] of [["chat", "chat@example.test"], ["late", "late@example.test"], ["boundary", "boundary@example.test"], ["other", "other@example.test"], ["old", "old@example.test"], ["staff", "staff@camelai.com"], ["deleted", "deleted@example.test"]]) {
    await db.query("insert into tenants (id, google_sub, google_email, created_at) values ($1, $1, $2, $3)", [id, email, id === "old" ? signup - 30 * DAY : signup]);
  }
  const grant = async (id: string, tenant: string, name: string, created: number, used: number | null, redirects: string[] = []) => {
    await db.query("insert into oauth_grants (id, tenant, client_name, client_id, scope, created_at, used_at) values ($1,$2,$3,$4,'agents',$5,$6)",
      [id, tenant, name, registration(name, redirects), created, used]);
  };
  await grant("chat-first", "chat", "Generic", signup, NOW - DAY, ["https://chatgpt.com/cb"]);
  await grant("chat-second", "chat", "Codex", signup + 1000, NOW - DAY);
  await grant("chat-duplicate", "chat", "ChatGPT", signup + 2000, NOW - DAY);
  await grant("late-first", "late", "Claude", signup + 3_600_001, NOW);
  await grant("boundary-first", "boundary", "Codex", signup + 3_600_000, null);
  await grant("other-first", "other", "Unknown", signup + 1, signup);
  await grant("other-later", "other", "ChatGPT", signup + 2, NOW);
  await grant("old-first", "old", "Claude", signup, NOW);
  await grant("staff-first", "staff", "Codex", signup, NOW);
  await grant("deleted-first", "deleted", "Codex", signup, NOW);
  await db.query("insert into account_deletions (tenant, requested_at, requested_by) values ('deleted',$1,'self')", [NOW]);
  await db.query("insert into journey_accounts (tenant, account_ref, internal, since_signup, consent, created_at) values ('chat','00000000-0000-4000-8000-000000000001',false,true,'granted',$1)", [signup]);
  await db.query("insert into agents (id,tenant,header,revision,name,type,model) values ('chat-agent','chat','{}',1,'Test','general','m')");
  for (const [day, model, responses] of [["2026-03-18", "m", 1], ["2026-03-19", "m", 1], ["2026-03-20", "brave/web_search", 1]] as const) {
    await db.query("insert into usage (tenant,day,model,responses) values ('chat',$1,$2,$3)", [day, model, responses]);
  }
  return { db, signup };
}

test("attribution uses only the first grant, includes the hour boundary and excludes staff/deleted/old accounts", async () => {
  const { db } = await fixture();
  const rows = await mcpSignupAttribution(db, NOW - 6 * DAY, NOW + DAY, ["camelai.com"]);
  assert.deepEqual(rows.map(row => [row.tenant, row.kind]).sort(), [["boundary", "codex"], ["chat", "chatgpt"], ["other", "other"]]);
  assert.equal(rows.find(row => row.tenant === "chat")?.account_ref, "00000000-0000-4000-8000-000000000001");
});

test("plugin reports deduplicate token activity and provide nested account-wide funnels", async () => {
  const { db } = await fixture();
  const report = await adminMcp(db, { days: 7, now: NOW, internalDomains: ["camelai.com"] });
  assert.equal(report.schema_version, 1);
  assert.equal(report.daily.length, 28);
  assert.equal(report.daily.reduce((sum, row) => sum + row.signups, 0), 3);
  const day = (date: string, kind: string) => report.daily.find(row => row.date === date && row.kind === kind)!;
  assert.equal(day("2026-03-19", "chatgpt").token_active_accounts, 1, "two grants on one day count one account");
  assert.equal(day("2026-03-20", "claude").token_active_accounts, 2, "existing accounts contribute activity");
  assert.equal(day("2026-03-20", "codex").token_active_accounts, 0, "unused, staff and erased grants do not contribute");
  assert.equal(report.weekly.find(row => row.week === "2026-03-16" && row.kind === "chatgpt")?.token_active_accounts, 2);
  assert.deepEqual(report.funnel.find(row => row.kind === "chatgpt"), { kind: "chatgpt", label: "ChatGPT plugin", authorized: 2, made_agent: 1, ran_turn: 1, came_back: 1 });
  assert.equal(report.funnel.find(row => row.kind === "claude")?.authorized, 1, "late connection can authorize, but is not acquisition");
  assert.equal(report.funnel.find(row => row.kind === "codex")?.authorized, 2);
  await db.query("delete from agents where id = 'chat-agent'");
  await db.query("delete from usage where day = '2026-03-19'");
  const oneDay = await adminMcp(db, { days: 7, now: NOW, internalDomains: ["camelai.com"] });
  assert.equal(oneDay.funnel[0].made_agent, 1, "a response proves a removed agent existed");
  assert.equal(oneDay.funnel[0].came_back, 0, "web searches alone are not returning model use");
  await assert.rejects(adminMcp(db, { days: 0, now: NOW }));
});

test("acquisition includes local plugin signups without journey records and uses local usage", async () => {
  const { db, signup } = await fixture();
  const fakeFetch = (async () => new Response(JSON.stringify({ schema_version: 1, kind: "journeys", range: { start_date: "2026-03-14", end_date: "2026-03-20", time_zone: "UTC" }, items: [{ account_ref: "00000000-0000-4000-8000-000000000001", signup_at: new Date(signup).toISOString(), activated_at: new Date(signup).toISOString(), payments: 1,
    acquisition: { capture_quality: "complete", source: "google", landing_host: "reports.example.test", landing_path: "/run" } }], next_cursor: null }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  const report = await adminAcquisition({ url: "https://reports.example.test", secret: `whsec_${Buffer.from("test-report-secret").toString("base64")}` }, { days: 7, now: NOW, db: db as Db, internalDomains: ["camelai.com"], fetch: fakeFetch });
  assert.equal(report.status, "ok");
  assert.deepEqual(report.sources.find(row => row.source === "ChatGPT plugin"), { source: "ChatGPT plugin", medium: null, signups: 1, made_agent: 1, activated: 1, active_two_days: 1, paying: 0, median_days_to_first_run: 0 });
  assert.equal(report.sources.find(row => row.source === "Codex plugin")?.signups, 1);
  assert.equal(report.total.signups, 4);
  const offline = await adminAcquisition(undefined, { days: 7, now: NOW, db: db as Db, internalDomains: ["camelai.com"] });
  assert.equal(offline.status, "not_configured");
  assert.deepEqual(offline.sources, report.sources);
  assert.equal(offline.daily.reduce((sum, row) => sum + row.counts.reduce((a, b) => a + b, 0), 0), 4);
  assert.equal(report.tracked_signups, 1);
});
