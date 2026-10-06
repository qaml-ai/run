# Tenant isolation contract

Every request is authenticated as a tenant: an operator token from the tenants
file or secret, a console session, an API token, or an agent's own token on the
SDK routes. Each agent, volume, definition, channel and schedule records its
tenant, and every API access check compares it with the caller's; another
tenant's agent is not found. Tests prove tenant A cannot list, read, prompt,
inspect or delete tenant B's agents. Per-tenant limits bound hosted agents
(`maxAgents`), model spend (`maxMonthlyCost`) and, for prepaid tenants, credit.

- **Generated code:** v8-exec (a bare V8 isolate per execution) confines generated JavaScript to the exposed
  capabilities. Tenant ownership is enforced by the runtime around it, not by
  the sandbox.
- **Application tools:** Tool implementations are trusted code in the tenant's
  application. Applications must limit them to the intended data and
  credentials; model-supplied arguments are not a trusted source of identity.
- **Shared chat (Studio):** Anyone who can reach Studio's `/a/:agentId` can
  access that agent's shared conversation and send prompts. Studio's developer
  access protects inspection and configuration data, not the conversation.
- **Host resources:** Guest execution limits do not isolate all host-process
  memory, filesystem permissions and network access; hosting customers'
  arbitrary Node/Python tool implementations would need a separate isolation
  boundary.
