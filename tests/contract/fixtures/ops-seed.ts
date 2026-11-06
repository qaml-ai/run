/** One account with a token, use, credit, a Telegram channel, schedules, everything it can connect and a help request: the ops tools' per-tenant shapes. */
export async function seedOpsAccount(query: (text: string, values?: unknown[]) => Promise<unknown>, now: number) {
  const day = 86_400_000;
  // An account made 20 days ago, with a token minted half a day later and two days of use.
  await query("insert into tenants (id, github, github_id, created_at, billing) values ('tnc_a', 'tnc-a', 12345, $1, 'prepaid')", [now - 20 * day]);
  await query("insert into api_tokens (sha256, id, tenant, name, prefix, created_at) values ('hash-a', '00000000-0000-0000-0000-0000000000a1', 'tnc_a', 'laptop', 'arr_', $1)", [now - 19.5 * day]);
  await query("insert into usage (tenant, day, model, responses, input, output, cost, platform_cost, platform_responses) values ('tnc_a', current_date - 20, 'test-model', 4, 100, 20, 0.5, 0.25, 2), ('tnc_a', current_date, 'test-model', 2, 10, 5, 0.1, 0, 0)");
  await query("insert into credit_accounts (tenant, balance, purchased) values ('tnc_a', 5000000, 10000000)");
  // A Telegram channel with one conversation and two inbound messages, and everything an account can connect.
  await query(`insert into channels (id, tenant, channel, created_at) values ('chn_1', 'tnc_a', '{"type":"telegram","name":"Support","account":{"bot":"@support"}}', $1)`, [now]);
  await query("insert into channel_conversations (channel, conversation, agent, generation) values ('chn_1', 'conv_1', 'agt_1', 1)");
  await query("insert into channel_seen (channel, message) values ('chn_1', 'msg_1'), ('chn_1', 'msg_2')");
  // Two schedules, both still ahead (a due one would run and be gone while the test reads): one recurring, one once.
  await query("insert into schedules (id, agent, tenant, text, due_at, every_seconds, created_at) values ('00000000-0000-0000-0000-0000000000b1', 'agt_1', 'tnc_a', 'daily report', $1, 3600, $2), ('00000000-0000-0000-0000-0000000000b2', 'agt_1', 'tnc_a', 'one off', $3, null, $2)", [now + 3_600_000, now, now + 7_200_000]);
  await query("insert into provider_keys (tenant, provider, sealed, last4, set_at) values ('tnc_a', 'openai', '{\"sealed\":\"secret\"}', '1234', $1)", [now]);
  await query("insert into model_providers (tenant, name, config, sealed, last4, set_at) values ('tnc_a', 'mine', '{\"type\":\"openai\"}', '{\"sealed\":\"secret\"}', '5678', $1)", [now]);
  await query("insert into webhook_endpoints (id, tenant, url, events, secret, created_at) values ('whk_1', 'tnc_a', 'https://hooks.example.test/x?token=secret', '{run.completed}', '{\"sealed\":\"secret\"}', $1)", [now]);
  await query("insert into volumes (id, tenant, name, created_at) values ('vol_1', 'tnc_a', 'data', $1)", [now]);
  await query("insert into help_requests (id, tenant, reference, payload_sha256, email_hash, status, created_at, updated_at) values ('00000000-0000-0000-0000-0000000000c1', 'tnc_a', 'HR-0001', 'abc', 'def', 'delivered', $1, $1)", [now]);
}
