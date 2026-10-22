# Workspaces

Workspaces group an account's agents and definitions by project or use case. In
the console, open **Workspaces**, create a workspace, then add agents and
definitions to it. The workspace switcher at the top of the sidebar scopes
**Agents**, **Definitions** and **Usage** to one workspace; channels, volumes,
API keys and billing stay account-wide.

Each agent belongs to at most one workspace. New agents inherit their
definition's workspace, and sub-agents and forks inherit their parent's. A
definition's assignment affects agents created afterward. Assign its existing
agents individually. A workspace groups resources inside one account; it does
not grant access to another account or share agents' files. Each agent still
has its own `/workspace` filesystem.

Usage keeps the workspace assigned when the call happened. Moving an agent
does not move earlier spend; a later provider cost correction stays with the
original call. Existing usage and calls without an assignment appear under
**Unassigned**. Costs include model calls and recorded tools such as X search,
web search, and images. Account-wide active-time and storage charges are not
allocated to workspaces.

Renaming a workspace keeps its members and history. Archiving keeps existing
agents running and preserves their attribution, but prevents new explicit
assignments. Restore it before assigning more agents. Deleting an agent does
not remove its workspace's spend.

## API

- `GET /v1/workspaces`: list workspaces, including archived ones.
- `POST /v1/workspaces` with `{ "name": "Trading Desk" }`: create one.
- `GET /v1/workspaces/{id}`: read one workspace.
- `PATCH /v1/workspaces/{id}` with `name` or `archived`: rename, archive, or restore.
- `GET /v1/workspaces/{id}/members`: list assigned agents and definitions.
- `GET /v1/workspace-memberships`: list current assignments.
- `PUT /v1/workspace-memberships/{kind}/{id}` with
  `{ "workspaceId": "ws_…" }`: assign an `agent` or `definition`. Send
  `{ "workspaceId": null }` to unassign it.
- `GET /v1/agents?workspaceId=ws_…`: a workspace's agents (`unassigned` for
  agents in none). Each agent in the list has its `workspaceId`.
- `GET /v1/usage?days=30&workspaceId=ws_…`: a workspace's usage. Use
  `workspaceId=unassigned` for unassigned usage; omit it for account totals and
  the `workspaces` summary.

When creating an agent or stateless run, pass `workspaceId` to override
inheritance, or `null` to leave it unassigned. An agent upsert without this field
keeps its current assignment. TypeScript accepts `workspaceId`; Python accepts
`workspace_id`. Assignment is controlled by the account, not by an agent's
tools. Account export includes the workspaces, assignment history, and usage.
