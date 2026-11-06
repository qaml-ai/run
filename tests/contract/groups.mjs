// File overrides precede areas because a few source suites span several APIs.
// Every case belongs to exactly one group; unmatched areas stay visible in other.
export const groups = {
  delegation: { areas: ["delegation"], files: ["multi-agent.contract.test.ts", "sdk-multi-agent.contract.test.ts", "tool-spawn.contract.test.ts", "background-agents.contract.test.ts"] },
  "tools-mcp": { areas: ["tools", "mcp", "human-input", "decisions", "search"], files: ["agent-mcp.contract.test.ts", "attach.contract.test.ts", "hosted-mcp.public.contract.test.ts", "inline-mcp-servers.public.contract.test.ts", "mcp.public.contract.test.ts", "ops-mcp.public.contract.test.ts", "webmcp.public.contract.test.ts"] },
  configuration: { areas: ["definitions", "keys", "selfhost"], files: ["agents-upsert.contract.test.ts", "selfhost.public.contract.test.ts", "admin-site.public.contract.test.ts"] },
  "files-attachments": { areas: ["files", "images", "volumes", "workspaces", "sources"], files: [] },
  "models-routing": { areas: ["models", "providers"], files: [] },
  "accounts-auth": { areas: ["accounts", "auth", "oauth", "access", "journey"], files: ["account.ported.test.ts", "email-signup.ported.test.ts", "operator-tenants.ported.test.ts", "tenant-reads.contract.test.ts", "journey.public.contract.test.ts", "identity-tokens.transport.contract.test.ts", "revocation.transport.contract.test.ts"] },
  webhooks: { areas: ["webhooks"], files: ["end-user-webhooks.ported.test.ts", "usage-webhook-recovery.ported.test.ts", "usage-webhooks.ported.test.ts"] },
  lifecycle: { areas: ["agents", "runs", "messages", "schedules", "history", "streaming"], files: ["deploy-drain.public.contract.test.ts", "http-drain.public.contract.test.ts"] },
  billing: { areas: ["billing", "credits", "quotas"], files: [] },
  channels: { areas: ["channels"], files: [] },
  other: { areas: [], files: [] },
};

export function groupFor(row) {
  const file = row.file?.split("/").at(-1);
  for (const [name, rule] of Object.entries(groups)) if (rule.files.includes(file)) return name;
  for (const [name, rule] of Object.entries(groups)) if (rule.areas.includes(row.area)) return name;
  return "other";
}

// Fixtures use a private random schema (Node) or database and workerd directory
// (Workers). No file currently shares mutable state with another process.
// Add an entry and reason here if a future suite acquires a shared resource.
export const serialFiles = {};
