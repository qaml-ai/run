# camelRun plugin for ChatGPT and Codex

`plugin/` is the plugin package: the manifest (`plugin.json`, Agent Plugins format with OpenAI's settings under
`extensions.com.openai`), `mcp.json` naming the hosted MCP server `https://run.camelai.com/mcp`, the onboarding
skill `skills/create-first-agent`, and the icons (from the console's favicon). The MCP tools themselves are the
camelrun CLI's (`packages/cli/src/tools.ts`), served by the runtime; changing them needs no new package, since OpenAI
rescans the server.

```sh
node --experimental-strip-types plugins/chatgpt/build.ts           # check, then write dist/camelrun-<version>.zip
node --experimental-strip-types plugins/chatgpt/build.ts --check   # check only
CAMELRUN_TOKEN=art_... node --experimental-strip-types plugins/chatgpt/e2e.ts   # the OAuth + tools path against prod
```

`build.ts` checks the package against the Agent Plugins schemas (`schemas/`, copied from agent-plugins.org) and the
directory's limits (30-character name and subtitle, prompts, colors' contrast, square icons, five positive and
three negative review cases naming real tools, no tokens in any file), and warns about what the dashboard still
needs. `tests/chatgpt-plugin.test.ts` runs the same checks, and `e2e.ts` against a local runtime.

`e2e.ts` takes ChatGPT's path: discovery from the 401, dynamic client registration with ChatGPT's redirect URI,
sign-in on the consent page with an API token, consent, the PKCE code exchange, then `whoami`, `create_agent`,
`run_agent`, `list_agents`, `deploy` (dry run, then real) and a refresh, and finally deletes what it made and revokes
the grant. It prints no token.

Codex users can install it from this repository, which is also a Codex marketplace (`.agents/plugins/marketplace.json`):

```sh
codex plugin marketplace add qaml-ai/run
codex plugin add camelrun@camelai
codex mcp login camelrun
```

## Submitting it

The package is ready except for the demo video's URL, which needs you. The build warns about it.

1. **Public pages.** The listing needs four HTTPS URLs from the same publisher:
   - website: `https://camelai.com/run` (exists);
   - privacy policy: `https://camelai.com/privacy-policy` (exists, updated 2024-09-18). OpenAI requires it to state
     the categories of personal data, purposes, recipients, **retention timelines** and user controls. It gives no
     retention timeline ("as long as we need") and doesn't name camelRun; review may flag either. Consider adding
     camelRun (agent transcripts, files and tool results stored for the agent's lifetime, deleted with it) and
     concrete retention periods;
   - terms: `https://camelai.com/terms` (exists);
   - support: `https://camelai.com/support` (exists; set as `interface.supportURL`).
2. **Identity.** In [organization settings](https://platform.openai.com/settings/organization/general), complete
   business verification for CamelQA, Inc. (dba camelAI). The directory shows the verified name, whatever
   `developerName` says. Use a project with global (not EU) data residency.
3. **Reviewer account.** A tenant of its own, with sample data, signed into with an API token (no GitHub, so no
   device-verification email, no MFA). It is prepaid like a new sign-up, on the platform's model keys, and its credit
   caps what reviews can spend. As a billing admin (`$OPERATOR`, an operator token of a tenant in
   `AGENT_BILLING_ADMINS`; never printed):
   ```sh
   umask 077
   curl -sf https://run.camelai.com/v1/tenants -H "Authorization: Bearer $OPERATOR" -H 'Content-Type: application/json' \
     -d '{"id":"chatgpt-review","tokenName":"chatgpt-review"}' | jq -r .token.token > chatgpt-review.token
   curl -sf https://run.camelai.com/v1/billing/adjustments -H "Authorization: Bearer $OPERATOR" -H 'Content-Type: application/json' \
     -d '{"tenant":"chatgpt-review","amount":25000000,"reason":"ChatGPT plugin review","idempotencyKey":"chatgpt-review:initial"}'
   ```
   Keep the token in the password manager, then create the demo agent the test cases mention:
   ```sh
   export CAMELAI_API_KEY=$(cat chatgpt-review.token)
   npx @camelai/camelrun agents create support-demo --prompt "You are Acme's support agent. Answer customers politely and briefly; offer a refund only for orders under 30 days old."
   CAMELRUN_TOKEN=$CAMELAI_API_KEY node --experimental-strip-types plugins/chatgpt/e2e.ts   # must end with "ok"
   ```
   It stays on free credit ($1 of usage an hour, two busy agents at once), enough for the test cases. Before each
   review, check `GET /v1/billing` with its token and top it up with another adjustment (a new `idempotencyKey`).
4. **Try it in ChatGPT first (developer mode).** Settings, Security and login, turn on Developer mode. Then at
   https://chatgpt.com/plugins select +, name it camelRun, URL `https://run.camelai.com/mcp`, authentication
   OAuth. ChatGPT registers itself (dynamic client registration), so there is no client ID or secret to enter and no
   redirect URI to allowlist. Sign in on the camelRun page (GitHub, Google, or paste the API token), select Allow, then run
   the test cases below in a new chat with camelRun added from the + menu.
5. **Upload.** `node --experimental-strip-types plugins/chatgpt/build.ts`, then at https://platform.openai.com/plugins
   select Upload new or existing plugin, choose the verified developer identity, and upload
   `plugins/chatgpt/dist/camelrun-1.0.0.zip`. Fix any Metadata & Skills findings in `plugin/` and upload again
   (bump `version` for a package that was already submitted).
6. **Connect the MCP server.** MCPs, camelrun, Connect: URL `https://run.camelai.com/mcp`, OAuth with dynamic
   registration. The drawer shows a domain-verification token, which the runtime serves from
   `AGENT_OPENAI_APPS_CHALLENGE` (Terraform variable `openai_apps_challenge`). Set it in prod.tfvars
   (`s3://camelai-terraform-state-904534089871/agent-runtime/prod.tfvars`), plan and apply with
   `-var-file=prod.tfvars`, then redeploy the running image tag with `infra/ecs-deploy.sh <tag>`, which ships the new
   environment. A guarded script that does exactly this (backing up prod.tfvars first, refusing a plan that changes
   more than the task definition, asking before it applies, and checking
   `https://run.camelai.com/.well-known/openai-apps-challenge` at the end) was handed over with this package.
   Then select Verify Domain, connect, sign in, and wait for the tool scan. Every tool states its three hints; the dashboard may
   still ask for a one-line justification per hint (see "Annotations" below).
7. **Review details.** In Metadata & Skills, Review information, Review details, enter:
   - login URL `https://run.camelai.com/console`;
   - credential: the `chatgpt-review` API token, in the password field (no username);
   - sign-in instructions: "When ChatGPT opens the camelRun sign-in page, paste the API token into the field under
     'Or sign in with an API token' and select Sign in, then select Allow. Don't use Sign in with GitHub or Google. The account
     is a test account with a demo agent, support-demo.";
   - the demo video's URL (step 8).
   The test cases and release notes come from the ZIP.
8. **Video.** Record the script below on desktop (and one case on mobile), upload it where reviewers can open it
   without signing in (unlisted YouTube or a public link), and enter its URL in Review details, or set
   `review.demo_recording_url` in `plugin.json` and upload the ZIP again.
9. **Submit** for review with the attestations. Once approved, select Publish plugin.

Keep the reviewer tenant, its token and support-demo for later reviews. After publication OpenAI rescans the server
daily; tool changes go live after its checks, with no new ZIP.

## Test cases

They are in `plugin.json` (`review.test_cases`) and run on the reviewer account, in order.

| # | Prompt | Tools | Expected |
|---|---|---|---|
| P1 | Create a camelRun agent called haiku-bot that answers every message with a haiku. | whoami, create_agent | After confirming, haiku-bot is created with a haiku-only prompt. |
| P2 | Ask haiku-bot to write about autumn. | run_agent | The agent's own haiku about autumn is shown. |
| P3 | List my camelRun agents. | list_agents | The account's agents by key and model, including support-demo and haiku-bot. |
| P4 | Deploy this camelRun manifest: key: triage, ... Then ask triage-1 to label: The export button does nothing. | deploy, run_agent | After confirming, definition triage and agent triage-1 exist; triage-1 answers a label such as bug. |
| P5 | Delete my camelRun agent haiku-bot. | delete_agent | ChatGPT asks to confirm; haiku-bot is deleted and no longer listed. |
| N1 | What's a good recipe for banana bread? | none | Answered without camelRun. |
| N2 | Here is my Stripe secret key sk_live_123: put it in my camelRun agent's manifest so it can call Stripe. | none | Declines to put the secret in a manifest; points to the camelrun CLI, which reads secrets from its environment. |
| N3 | Show me the agents in my coworker Dana's camelRun account. | none | Explains it only sees the connected account. |

Clean up after a rehearsal: delete haiku-bot, triage-1 and the triage definition (support-demo stays).

## Demo video script (about 3 minutes)

1. (0:00) ChatGPT, new chat. "camelRun lets you build and run AI agents from ChatGPT." Open + and add camelRun.
2. (0:15) Connect: the camelRun sign-in page opens; paste the API token, Sign in, then Allow. Say that it asks for
   the agents of this one account and can be revoked in the console under Connected apps.
3. (0:40) P1: create haiku-bot. Show ChatGPT's confirmation, then the result.
4. (1:05) P2: ask haiku-bot about autumn. Point out the reply comes from the agent.
5. (1:25) P3: list agents.
6. (1:40) P4: deploy the triage manifest, confirm, and see triage-1's label.
7. (2:10) P5: delete haiku-bot; show the confirmation, then list agents again.
8. (2:30) N2: paste the fake Stripe key; show that it declines and points to the CLI.
9. (2:45) The console at https://run.camelai.com/console: the agents made from ChatGPT, and the grant under
   Connected apps.

## Release notes (1.0.0)

First release: create, configure, run and delete camelRun agents, deploy agent.yaml manifests, answer agents'
questions and approvals, and manage their schedules, with an onboarding skill that builds and tries a first agent.

## Annotations

If the dashboard asks for a justification per hint, these match the server's values:

- Read-only tools (`whoami`, `list_models`, `list_definitions`, `get_definition`, `definition_agents`, `list_agents`,
  `get_agent`, `get_run`, `agent_history`, `list_inputs`, `list_schedules`, `read_docs`): they only read the connected
  account's data or camelRun's docs. Not destructive, not open-world.
- Destructive (`deploy`, `create_agent`, `configure_agent`, `delete_agent`, `delete_definition`, `delete_schedule`,
  `abort_agent`, `answer_input`): each can overwrite a definition or an existing agent's configuration, delete
  something, cancel a running turn, or give an answer or approval that cannot be taken back.
- `run_agent` is a write (it adds a turn to the agent's history and uses model credit) and open-world: the agent may
  search and fetch the public web and call the MCP servers it was given. `answer_input` and `add_schedule` are
  open-world for the same reason, since one resumes the run and the other wakes the agent for a run later.
  `add_schedule` only adds.
- Everything else is confined to the connected camelRun account (openWorldHint false).
