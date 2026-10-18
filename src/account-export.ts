import type { Accounts } from "./accounts.ts";
import type { ClientSessions } from "./client-sessions.ts";
import type { Channels } from "./channels.ts";
import type { Definitions } from "./definitions.ts";
import type { HistoryPage } from "./history-pages.ts";
import { HttpError } from "./http.ts";
import { journeyKept, type Journey } from "./journey.ts";
import type { OAuth } from "./oauth.ts";
import type { VolumeService } from "./volumes.ts";
import type { Webhooks } from "./webhooks.ts";
import type { Telemetry } from "./telemetry.ts";
import { ZipWriter } from "./zip.ts";
import { mcpServerView } from "./tool-sources.ts";

/**
 * A tenant's data as one zip (GET /v1/account/export), written as it is read: each agent's
 * configuration and whole history (a page of turns at a time), its definitions, channels and
 * webhooks (secrets left out, as the API shows them), every volume's files, and its credit ledger
 * and usage. Nothing is held beyond the page, file chunk or ledger page being written.
 */
export interface ExportOptions {
  accounts: Accounts;
  clients: ClientSessions;
  volumes?: VolumeService;
  definitions?: Definitions;
  channels?: Channels;
  webhooks?: Webhooks;
  telemetry?: Telemetry;
  oauth?: OAuth;
  /**
   * A page of an agent's history from the node that serves it (another node's agent has turns only it holds yet);
   * by default this node's view, which is whole only when no other node serves the agent.
   */
  historyPage?: (id: string, tenant: string, query: { before?: string; limit?: string }) => Promise<HistoryPage>;
  /** Journey events (src/journey.ts), where the operator configured them: the store is asked for what it holds of the account. */
  journey?: Journey;
}

const README = `This archive holds everything camelRun stores for your account, as of the time it was made.

account.json               your account: its id and the identity you sign in with
agents/<id>/agent.json     each agent's configuration and schedules
agents/<id>/history/*.json each agent's history, a page of whole turns per file, named by its first message's index
definitions.json           your agent definitions (secrets left out)
channels.json              your channels (credentials masked)
webhooks.json              your webhook endpoints (signing secrets left out)
telemetry.json             where your traces are exported (header values left out)
tokens.json                your API tokens' names and prefixes (never the tokens)
keys.json                  which provider keys are set (the last four characters, never the keys)
oauth-grants.json          the applications you let act for your account
discord.json               managed Discord server bindings and pending setup metadata (never credentials or session/state hashes)
volumes/<id>/volume.json   each volume's name and size
volumes/<id>/files/...     each volume's files
billing/ledger.jsonl       your credit ledger, one entry per line, newest first
billing/usage.json         model usage per day and model
billing/attempts.jsonl     durable model attempts and settlement state (no key fingerprints)
end-users/settings.json    how you meter your own users' credit
end-users/end-users.jsonl  each of your users' balance and overrides
end-users/ledger.jsonl     their credit ledger: your grants, refunds and adjustments, and each call's usage
analytics/account.json     only if this service measures how its website and console are used: the ids your account is known by there, and what was noted of it here
analytics/summary.json     what the operator's analytics store says of how your account came to be
analytics/events-*.json    the events it holds of your account, oldest first
analytics/touches-*.json   where your browser came from, as it holds it
analytics/google-copies-*.json  what it prepared or sent to Google Analytics of those events, and whether it did
`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export async function* exportAccount(options: ExportOptions, tenant: string): AsyncGenerator<Uint8Array> {
  const { accounts, clients } = options;
  const historyPage = options.historyPage ?? ((id: string, tenant: string, query: { before?: string; limit?: string }) => clients.historyPageFor(id, tenant, query));
  const zip = new ZipWriter();
  const created = (await accounts.db.query("select created_at from tenants where id = $1", [tenant])).rows[0]?.created_at;
  yield* zip.file("README.txt", README);
  const email = (await accounts.db.query("select email from tenant_passwords where tenant = $1", [tenant])).rows[0]?.email ?? null;
  yield* zip.file("account.json", json({ tenant, login: await accounts.identity(tenant) ?? null, email, createdAt: created === undefined ? null : Number(created), exportedAt: new Date().toISOString() }));

  for (let after = ""; ;) {
    const { rows } = await accounts.db.query(`
      select id, header from agents where tenant = $1 and id > $2 and not revoked and purged_at is null and (expires_at is null or expires_at > $3)
      order by id limit 100`, [tenant, after, Date.now()]);
    for (const { id, header } of rows) {
      const schedules = (await accounts.db.query("select id, text, code, history, due_at, every_seconds, created_at from schedules where agent = $1 order by created_at, id", [id])).rows
        .map(row => ({ id: row.id, ...(row.text !== null ? { text: row.text } : {}), ...(row.code !== null ? { code: row.code } : {}), ...(row.history !== null ? { history: row.history } : {}), dueAt: Number(row.due_at), everySeconds: row.every_seconds, createdAt: Number(row.created_at) }));
      yield* zip.file(`agents/${id}/agent.json`, json({ ...agentView(header), schedules }));
      // Every message from the newest back to the first, or the export fails: a history cut short is never exported as whole.
      let total: number | undefined, read = 0, deleted = false;
      for (let before: string | undefined; ;) {
        const page = await historyPage(id, tenant, { limit: "500", ...(before !== undefined ? { before } : {}) }).catch(error => {
          // Deleted while the export ran: it has no history left to give.
          if ((error as HttpError).status === 404) return undefined;
          throw error;
        });
        if (!page) { deleted = true; break; }
        total ??= page.total;
        read += page.entries.length;
        if (page.entries.length) yield* zip.file(`agents/${id}/history/${String(page.entries[0].index).padStart(9, "0")}.json`, json(page.entries));
        if (page.next === null) break;
        before = String(page.next);
      }
      if (!deleted && read !== total) throw new Error(`Agent ${id}'s history read ${read} of its ${total} messages; the export is incomplete`);
    }
    if (rows.length < 100) break;
    after = rows.at(-1)!.id;
  }

  if (options.definitions) yield* zip.file("definitions.json", json(await options.definitions.list(tenant)));
  if (options.channels) yield* zip.file("channels.json", json(await options.channels.list(tenant)));
  if (options.webhooks) yield* zip.file("webhooks.json", json(await options.webhooks.list(tenant)));
  const telemetry = await options.telemetry?.get(tenant);
  if (telemetry) yield* zip.file("telemetry.json", json(telemetry));
  yield* zip.file("tokens.json", json(await accounts.listTokens(tenant)));
  yield* zip.file("keys.json", json(await accounts.keyStatus(tenant)));
  if (options.oauth) yield* zip.file("oauth-grants.json", json(await options.oauth.grants(tenant)));
  const [bindings, attempts] = await Promise.all([
    accounts.db.query(`select b.id, b.application_id, b.guild_id, b.channel_id, b.state,
      b.allowed_channel_ids, b.administrator_id, b.created_at, b.updated_at,
      i.name guild_name, i.state installation_state
      from discord_server_bindings b join discord_installations i using (application_id, guild_id)
      where b.tenant = $1 order by b.created_at, b.id`, [tenant]),
    accounts.db.query("select guild_id, expires_at from discord_setup_attempts where tenant = $1 order by expires_at, guild_id", [tenant]),
  ]);
  yield* zip.file("discord.json", json({
    serverBindings: bindings.rows.map(row => ({
      id: row.id, applicationId: row.application_id, guildId: row.guild_id, guildName: row.guild_name,
      channelId: row.channel_id, state: row.state, installationState: row.installation_state,
      allowedChannelIds: row.allowed_channel_ids, administratorId: row.administrator_id,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    })),
    setupAttempts: attempts.rows.map(row => ({ guildId: row.guild_id, expiresAt: Number(row.expires_at) })),
  }));

  const volumes = options.volumes;
  if (volumes) {
    for (const { id } of await volumes.list(tenant)) {
      yield* zip.file(`volumes/${id}/volume.json`, json(await volumes.call(id, tenant, "info")));
      for (let after: string | undefined; ;) {
        const { files, next } = await volumes.call(id, tenant, "list", { path: "/", ...(after !== undefined ? { after } : {}) }) as { files: { path: string; size: number; chunks: string[]; updatedAt: number }[]; next?: string };
        for (const file of files) yield* zip.file(`volumes/${id}/files${file.path}`, volumes.stream(tenant, file), new Date(file.updatedAt));
        if (!next) break;
        after = next;
      }
    }
  }

  yield* zip.file("billing/ledger.jsonl", (async function* () {
    for (let before: number | undefined; ;) {
      const { entries, next } = await accounts.billing.ledger(tenant, { limit: 200, ...(before !== undefined ? { before } : {}) });
      if (entries.length) yield Buffer.from(entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
      if (next === undefined) return;
      before = next;
    }
  })());
  yield* zip.file("billing/usage.json", json(await accounts.usage(tenant, 0)));
  yield* zip.file("billing/attempts.jsonl", (async function* () {
    for (let after = "00000000-0000-0000-0000-000000000000"; ;) {
      const { rows } = await accounts.db.query("select id,agent,provider,model,kind,platform,context,generation_id,state,started_at,updated_at,totals,charge,revision,last_error from model_attempts where tenant=$1 and id>$2 order by id limit 200", [tenant, after]);
      if (!rows.length) return;
      yield Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      after = rows.at(-1)!.id;
    }
  })());

  // The tenant's own users' credit (end-user-credits.ts): its settings, each user's balance and overrides, and their ledger.
  yield* zip.file("end-users/settings.json", json((await accounts.db.query("select enabled, allowances, bucket_limits, daily_limit, markup_bps, low_balance, updated_at from end_user_settings where tenant=$1", [tenant])).rows[0] ?? null));
  yield* zip.file("end-users/end-users.jsonl", (async function* () {
    for (let after = ""; ;) {
      const { rows } = await accounts.db.query("select id, balance, allowances, bucket_limits, daily_limit, created_at, updated_at from end_users where tenant=$1 and id>$2 order by id limit 200", [tenant, after]);
      if (!rows.length) return;
      yield Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      after = rows.at(-1)!.id;
    }
  })());
  yield* zip.file("end-users/ledger.jsonl", (async function* () {
    for (let after = 0; ;) {
      const { rows } = await accounts.db.query("select id, end_user, kind, amount, raw, allowance, bucket, idempotency_key, reference, metadata, balance_after, created_at from end_user_ledger where tenant=$1 and id>$2 order by id limit 200", [tenant, after]);
      if (!rows.length) return;
      yield Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      after = Number(rows.at(-1)!.id);
    }
  })());

  // Journey events, where this runtime ever sent any of the account: what it keeps itself, then what the operator's store holds.
  const kept = await journeyKept(accounts.db, tenant);
  if (kept) {
    const journey = options.journey;
    yield* zip.file("analytics/account.json", json({ ...kept, store: journey ? "asked: see summary.json, events-*.json and touches-*.json" : "not configured on this runtime now: what it holds is not in this archive" }));
    if (journey) {
      let summary: { status: string; account: unknown; consent: unknown } | undefined;
      for (const kind of ["events", "touches"] as const) {
        let page = 0, copies = 0;
        for await (const { status, account, consent, records, googleCopies } of journey.stored(kept.accountRef, kind)) {
          summary ??= { status, account, consent };
          if (records.length) yield* zip.file(`analytics/${kind}-${String(++page).padStart(5, "0")}.json`, json(records));
          if (googleCopies.length) yield* zip.file(`analytics/google-copies-${String(++copies).padStart(5, "0")}.json`, json(googleCopies));
        }
      }
      yield* zip.file("analytics/summary.json", json(summary));
    }
  }
  yield* zip.end();
}

/** An agent's configuration from its stored header, as GET /v1/agents/:id shows it, without its sealed tool-source secrets or model header values. */
function agentView(header: any) {
  const config = header.config ?? {};
  return {
    id: header.id, key: header.key ?? null, name: header.metadata?.name ?? null, type: header.metadata?.type ?? "general", metadata: header.metadata ?? {},
    model: config.model ? `${config.model.provider}/${config.model.id}` : null, systemPrompt: config.systemPrompt ?? "",
    ...(config.systemPromptAppend ? { systemPromptAppend: config.systemPromptAppend } : {}), ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
    ...(config.maxOutputTokens != null ? { maxOutputTokens: config.maxOutputTokens } : {}), ...(config.temperature != null ? { temperature: config.temperature } : {}), ...(config.dataCollection != null ? { dataCollection: config.dataCollection } : {}),
    tools: header.definitions ?? [], mounts: header.mounts ?? [], definition: header.definition ?? null, keyScope: header.keyScope ?? null,
    identity: header.identity ?? null, builtins: header.sources?.builtins ?? [], mcpServers: (header.sources?.mcpServers ?? []).map(mcpServerView), expiresAt: header.expiresAt,
    ...(config.modelHeaders ? { modelHeaders: Object.keys(config.modelHeaders) } : {}),
  };
}
