# Vault and egress review

Migration: `124_vault_secrets.sql` (free on origin/main fetched November 9).
No production writes, push or PR.

## Implemented

- Tenant/workspace write-only vault CRUD, existing key sealing, names-only lists,
  tenant-scoped SQL and account-deletion cleanup. No vault cache.
- Public-suffix-aware host rules, wildcard label boundaries, header-default
  injection policy with explicit query/body opt-in.
- Shared Workers gateway for exchange, GitHub App and vault auth. Attached
  computer placeholders, host checks, manual redirects and streaming response
  masking, including values split across chunks. Binary bodies remain binary
  unless they contain an explicit placeholder. Vault substitution bodies are
  capped at 8 MiB.
- Vault references for remote MCP and OpenAPI sources. Per-request resolution,
  destination checks, response masking. Vault MCP refuses legacy SSE transport.
- Workers native computers use internet-disabled HTTPS interception for limited
  networking. Network policy also checks built-in web requests and remote source
  hosts. Attached external computers are unavailable under limited networking.
- Node/Sprites rejects limited networking. It supports vault APIs and remote
  source credentials, but does not have the Workers computer placeholder gateway.
- TypeScript/Python vault methods, network configuration, API schemas, guide and
  generated docs. CLI/registry/create-run-app use the existing manifest/definition
  passthrough; no existing caller payload changes are required.

## Limits for review

This is not complete parity. Native computer placeholder injection is Workers
only. No deployed container or real external MCP credential test was run. The
new contract covers CRUD on both backends; the gateway tests exercise forwarding
with a test transport. Existing Workers DNS checks are not connection-pinned.
Network policy covers native computer egress, web tools and configured remote
sources; platform file-import/image/voice fetches have not been audited for
per-agent allowlist coverage. Those remain a gate before treating limited
networking as a complete agent-wide boundary.

## camel-bots compatibility

Searched `~/camel-bots/src` for the changed definition/agent routes and SDK
methods. Existing uses are in `src/api/builder.ts`, `src/api/bot-workers.ts`,
`src/app/agents.ts`, `src/app/camelrun.ts`, and `src/ops/triage-agent.ts`.
They use existing definition payloads, runtime/exchange authentication, agent
creation and configuration. The new fields/routes are optional and existing
payloads keep their semantics. No camel-bots changes are required for this patch.
The host rules in `codex/secret-hosts-2:src/shared/secret-hosts.ts` and the current
`src/runtime/secrets.ts` informed this implementation; tldts supplies the complete
public suffix list rather than a fixed suffix subset.

## New model-facing strings (verbatim)

Descriptions (templates retain their source interpolation):

```text
Network access is limited to allowed hosts.
 Vault placeholders are in environment variables: ${settings.secrets.map(s => s.name).join(", ")}.
```

Runtime errors that can reach a tool response:

```text
Vault request refused
Network destination is not allowed
Egress request failed
Vault is unavailable
Vault database is unavailable
Secret not found
Secret is not allowed at this destination or location
Secrets cannot be used in the host or path
Secret substitution changed the destination
Unattached secret placeholder
Vault request body exceeds 8 MiB
Authenticated MCP requests cannot change origin
Authenticated source redirects are not allowed
Vault MCP request failed
Vault source request failed
Vault credentials require streamable HTTP MCP
Limited networking is unavailable on the Node/Sprites backend
[hidden]
```

No new model tools or system-prompt instructions were added. Existing egress
credential errors and tenant-only configuration errors retain their templates;
`networking` is now a tenant-only field.
