### Ops: sign-ups and activity by MCP plugin (ChatGPT, Codex, Claude)

The ops dashboard has an MCP plugins tab (`GET /ops/api/mcp?days=7|30|90`). It reads existing tables; there is no migration or change to OAuth authentication.

- Sign-ups: self-serve `tenants.created_at` in the selected window, classified by the first retained `oauth_grants` row if it was created within one hour (inclusive). Later connections do not change acquisition. The Growth source report joins these accounts through `journey_accounts.account_ref` and substitutes the plugin label, including sign-ups whose browser ran in the OAuth flow. Growth still requires a configured journey store and includes only its tracked sign-ups; the MCP tab does not.
- Daily and weekly token activity: distinct accounts by kind from `oauth_grants.used_at`. Weeks start Monday UTC and cover only the selected dates. The column stores **token issuance/refresh**, not authenticated requests, and overwrites earlier activity. These are not complete historical MCP active-account counts; they can decrease as tokens refresh outside the window.
- Funnel: accounts signed up in the window that have authorized each kind by now, then have an `agents` row or model-response usage, then model-response usage in `usage`, then usage on a day after their first response. Each step is a subset of the previous step. Progress is account-wide, including work outside the plugin. An account can appear under multiple kinds. Removed agents can be inferred from retained usage.
- Tool calls: omitted. Neither hosted MCP (`src/hosted-mcp.ts`) nor per-agent MCP (`src/agent-mcp.ts`) stores incoming tool-call records with an OAuth grant/client. Model usage and outgoing MCP tool activity cannot establish the caller's plugin.

All metrics exclude staff and erased accounts by the existing admin rules. Revoking a grant deletes it, so both attribution and authorization counts can disappear or change to the next retained grant. The report does not claim durable first-touch history.

Registration data is in the signed `oauth_grants.client_id` payload (`n` = name, `r` = redirect URIs, `m` = auth method). The report decodes only stored registrations; it does not accept these ids as authentication. Exact HTTPS callback hosts `chatgpt.com` / `chat.openai.com` identify ChatGPT and `claude.ai` identifies Claude. Otherwise exact names ChatGPT, Codex, Claude and Claude Code are recognized, case-insensitively. Unrecognized registrations remain Other MCP; a loopback callback alone is not Codex. These fields are client-declared, not verified vendor identity.

Evidence for matching (checked 2026-10-21):

- [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth) describes ChatGPT's `chatgpt.com` callback URIs.
- [Codex's OAuth registration implementation](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/oauth_client_registration.rs) sends `with_client_name("Codex")`; its callback is loopback, not a uniquely identifying host.
- `src/oauth.ts` `register`, `clientId`, `exchange`, `issue`, `authenticate` establish the local storage format, grant creation, last token timestamp semantics, and absence of per-request writes. No production data was queried.
