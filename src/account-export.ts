import type { Accounts } from "./accounts.ts";
import type { ClientSessions } from "./client-sessions.ts";
import type { Channels } from "./channels.ts";
import type { Definitions } from "./definitions.ts";
import { HttpError } from "./http.ts";
import type { OAuth } from "./oauth.ts";
import type { VolumeService } from "./volumes.ts";
import type { Webhooks } from "./webhooks.ts";
import { ZipWriter } from "./zip.ts";

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
  oauth?: OAuth;
}

const README = `This archive holds everything camelRun stores for your account, as of the time it was made.

account.json               your account: its id and the identity you sign in with
agents/<id>/agent.json     each agent's configuration and schedules
agents/<id>/history/*.json each agent's history, a page of whole turns per file, named by its first message's index
definitions.json           your agent definitions (secrets left out)
channels.json              your channels (credentials masked)
webhooks.json              your webhook endpoints (signing secrets left out)
tokens.json                your API tokens' names and prefixes (never the tokens)
keys.json                  which provider keys are set (the last four characters, never the keys)
oauth-grants.json          the applications you let act for your account
discord.json               managed Discord server bindings and account-link/setup metadata (never credentials or session/state hashes)
volumes/<id>/volume.json   each volume's name and size
volumes/<id>/files/...     each volume's files
billing/ledger.jsonl       your credit ledger, one entry per line, newest first
billing/usage.json         model usage per day and model
`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export async function* exportAccount(options: ExportOptions, tenant: string): AsyncGenerator<Uint8Array> {
  const { accounts, clients } = options;
  const zip = new ZipWriter();
  const created = (await accounts.db.query("select created_at from tenants where id = $1", [tenant])).rows[0]?.created_at;
  yield* zip.file("README.txt", README);
  yield* zip.file("account.json", json({ tenant, login: await accounts.identity(tenant) ?? null, createdAt: created === undefined ? null : Number(created), exportedAt: new Date().toISOString() }));

  for (let after = ""; ;) {
    const { rows } = await accounts.db.query(`
      select id, header from agents where tenant = $1 and id > $2 and not revoked and purged_at is null and (expires_at is null or expires_at > $3)
      order by id limit 100`, [tenant, after, Date.now()]);
    for (const { id, header } of rows) {
      const schedules = (await accounts.db.query("select id, text, code, due_at, every_seconds, created_at from schedules where agent = $1 order by created_at, id", [id])).rows
        .map(row => ({ id: row.id, ...(row.text !== null ? { text: row.text } : {}), ...(row.code !== null ? { code: row.code } : {}), dueAt: Number(row.due_at), everySeconds: row.every_seconds, createdAt: Number(row.created_at) }));
      yield* zip.file(`agents/${id}/agent.json`, json({ ...agentView(header), schedules }));
      for (let before: string | undefined; ;) {
        const page = await clients.historyPageFor(id, tenant, { limit: "500", ...(before !== undefined ? { before } : {}) }).catch(error => {
          // Deleted while the export ran: it has no history left to give.
          if ((error as HttpError).status === 404) return undefined;
          throw error;
        });
        if (!page) break;
        if (page.entries.length) yield* zip.file(`agents/${id}/history/${String(page.entries[0].index).padStart(9, "0")}.json`, json(page.entries));
        if (page.next === null) break;
        before = String(page.next);
      }
    }
    if (rows.length < 100) break;
    after = rows.at(-1)!.id;
  }

  if (options.definitions) yield* zip.file("definitions.json", json(await options.definitions.list(tenant)));
  if (options.channels) yield* zip.file("channels.json", json(await options.channels.list(tenant)));
  if (options.webhooks) yield* zip.file("webhooks.json", json(await options.webhooks.list(tenant)));
  yield* zip.file("tokens.json", json(await accounts.listTokens(tenant)));
  yield* zip.file("keys.json", json(await accounts.keyStatus(tenant)));
  if (options.oauth) yield* zip.file("oauth-grants.json", json(await options.oauth.grants(tenant)));
  const [bindings, links, attempts] = await Promise.all([
    accounts.db.query(`select b.id, b.application_id, b.guild_id, b.channel_id, b.state,
      b.allowed_channel_ids, b.administrator_id, b.created_at, b.updated_at,
      i.name guild_name, i.state installation_state
      from discord_server_bindings b join discord_installations i using (application_id, guild_id)
      where b.tenant = $1 order by b.created_at, b.id`, [tenant]),
    accounts.db.query("select discord_user_id, expires_at from discord_account_links where tenant = $1 order by discord_user_id, expires_at", [tenant]),
    accounts.db.query("select guild_id, expires_at from discord_setup_attempts where tenant = $1 order by expires_at, guild_id", [tenant]),
  ]);
  yield* zip.file("discord.json", json({
    serverBindings: bindings.rows.map(row => ({
      id: row.id, applicationId: row.application_id, guildId: row.guild_id, guildName: row.guild_name,
      channelId: row.channel_id, state: row.state, installationState: row.installation_state,
      allowedChannelIds: row.allowed_channel_ids, administratorId: row.administrator_id,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    })),
    accountLinks: links.rows.map(row => ({ discordUserId: row.discord_user_id, expiresAt: Number(row.expires_at) })),
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
  yield* zip.end();
}

/** An agent's configuration from its stored header, as GET /v1/agents/:id shows it, without its sealed tool-source secrets or model header values. */
function agentView(header: any) {
  const config = header.config ?? {};
  return {
    id: header.id, key: header.key ?? null, name: header.metadata?.name ?? null, type: header.metadata?.type ?? "general", metadata: header.metadata ?? {},
    model: config.model ? `${config.model.provider}/${config.model.id}` : null, systemPrompt: config.systemPrompt ?? "",
    ...(config.systemPromptAppend ? { systemPromptAppend: config.systemPromptAppend } : {}), ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
    tools: header.definitions ?? [], mounts: header.mounts ?? [], definition: header.definition ?? null, keyScope: header.keyScope ?? null,
    identity: header.identity ?? null, builtins: header.sources?.builtins ?? [], expiresAt: header.expiresAt,
    ...(config.modelHeaders ? { modelHeaders: Object.keys(config.modelHeaders) } : {}),
  };
}
