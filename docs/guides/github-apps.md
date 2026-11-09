# GitHub Apps

An agent that reads or changes code on GitHub needs a credential, and the right
one is a GitHub App's installation token: it lasts an hour and reaches only the
repositories and permissions it was made for. Minting one takes the App's
private key. Store the App in camelRun once, and the runtime mints tokens
itself wherever a definition asks for one: for an MCP server, an OpenAPI
source, a computer's `git push`, or a GitHub channel. Your application runs no
server for it, and the key never leaves camelRun.

## Store an App

Create the App on GitHub (Settings, Developer settings, GitHub Apps), give it
the permissions your agents need, generate a private key and install it on the
accounts or repositories it should reach. Then store it:

```bash
curl -X POST https://run.camelai.com/v1/github-apps \
  -H "Authorization: Bearer $CAMELRUN_KEY" -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile key app.private-key.pem '{name: "code", appId: "123456", privateKey: $key}')"
```

```json
{ "id": "gha_0123456789abcdef0123", "name": "code", "appId": "123456", "slug": "acme-code",
  "owner": "acme", "htmlUrl": "https://github.com/apps/acme-code",
  "masked": { "privateKey": "…k2v9TQ8sRw…" }, "createdAt": 1794000000000, "updatedAt": 1794000000000 }
```

- The runtime checks the key before it keeps it: it signs a JWT with it and
  asks GitHub who the App is (`GET /app`). A key that is not the App's, or an
  App ID that does not match, is a 422.
- `privateKey` is the PEM GitHub gives (PKCS#1) or PKCS#8. `webhookSecret` is
  optional; a [GitHub channel](channels.md) that uses the App needs it.
- `name` is what definitions call the App; it defaults to the App's slug. A
  tenant has at most 50 Apps.
- `hosts` lists the hosts, besides GitHub's own, that MCP servers and OpenAPI
  sources may send the App's tokens to (at most 20, host names only). GitHub's
  own are `github.com`, `api.github.com`, `uploads.github.com`,
  `codeload.github.com`, `raw.githubusercontent.com` and
  `api.githubcopilot.com` (GitHub's MCP server). A source at any other host
  gets no token. Only your API keys and console can change an App, so a client
  you let write definitions (an OAuth app acting for you) cannot point a token
  at a server of its own.
- The key and the webhook secret are sealed with the runtime's secrets key, as
  provider keys are, and never returned: the API shows them masked.

| Call | |
| --- | --- |
| `GET /v1/github-apps` | your Apps, masked |
| `POST /v1/github-apps` | store one: `{ name?, appId, privateKey, webhookSecret?, hosts? }` |
| `POST /v1/github-apps/manifest` | store the App GitHub made from your manifest: `{ code, name? }` |
| `GET /v1/github-apps/{app}` | one App, by id or name |
| `PATCH /v1/github-apps/{app}` | `{ name?, hosts?, privateKey?, webhookSecret? }`: rename it, change its hosts, rotate its key, set its secret (`null` removes it or the hosts) |
| `DELETE /v1/github-apps/{app}` | delete it |

### From a manifest

With GitHub's [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
your setup page makes the App in one step. Post a form to
`https://github.com/settings/apps/new` (or
`https://github.com/organizations/<org>/settings/apps/new`) with a `manifest`
field naming the App's permissions and a `redirect_url`. When the person
confirms, GitHub creates the App and redirects to your URL with `?code=…`.
Hand that code to camelRun within the hour:

```bash
curl -X POST https://run.camelai.com/v1/github-apps/manifest \
  -H "Authorization: Bearer $CAMELRUN_KEY" -H "Content-Type: application/json" \
  -d '{"code": "a1b2c3…"}'
```

The runtime exchanges it (`POST /app-manifests/{code}/conversions`) and stores
the App with its key and webhook secret, which nobody ever sees. GitHub's OAuth
client secret for the App is not kept. A code works once; the person still
installs the App on their repositories.

### Rotating the key

Generate a new key in the App's settings and send it:

```bash
curl -X PATCH https://run.camelai.com/v1/github-apps/code \
  -H "Authorization: Bearer $CAMELRUN_KEY" -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile key new.pem '{privateKey: $key}')"
```

The new key is checked with GitHub first. From then on every token is minted
with it: a token minted under the old key is not reused. Then delete the old
key on GitHub. Tokens minted before keep working until they expire, as GitHub's
always do.

## Use it: `auth: {"type": "github-app"}`

Wherever a definition takes it, `auth` names the App and what the token may do:

```json
{ "type": "github-app", "app": "code",
  "repositories": ["acme/api", "acme/web"],
  "permissions": { "contents": "write", "pull_requests": "write", "metadata": "read" } }
```

| Field | |
| --- | --- |
| `app` | the App's name or id |
| `repositories` | `owner/name` of each repository the token may reach, all of one owner (at most 500). Left out: every repository the installation reaches |
| `permissions` | GitHub permission names, each `read`, `write` or `admin`. Left out: the installation's own. Ask for no more than the agent needs |
| `owner` | the user or organization whose installation to use |
| `installation` | the installation's id, when you know it |

The installation is the one given, else the repositories' (`GET
/repos/{owner}/{repo}/installation`), else the owner's, else the App's only
installation; an App installed in several places needs one of these. The shape
is checked when the definition is saved; that the App exists, when a token is
minted.

### MCP servers and OpenAPI sources

```json
{"name": "Triage",
 "mcpServers": [{ "name": "github", "url": "https://api.githubcopilot.com/mcp/",
   "auth": { "type": "github-app", "app": "code", "repositories": ["acme/api"], "permissions": { "issues": "write", "metadata": "read" } } }],
 "openApi": [{ "name": "gh", "spec": "https://app.example.com/github-pulls.openapi.json", "baseUrl": "https://api.github.com",
   "auth": { "type": "github-app", "app": "code", "repositories": ["acme/api"], "permissions": { "pull_requests": "write" } } }]}
```

Each request carries `Authorization: Bearer <installation token>`. Saving the
definition lists an MCP server's tools, so it mints a token then: an App that
is not yours, or not installed where the auth asks, fails the save with a 400
saying what GitHub answered. Later, the same failure makes the source
unavailable for the call (`source_unavailable`), and the model reads why.

### A computer's git and API traffic

On the Workers backend a definition's `computer.egress` grants a native
computer HTTPS to named hosts, and a grant's credential is added by the
runtime's gateway outside the machine. With `github-app` auth the gateway adds
an installation token:

```json
{"computer": { "egress": [
  { "host": "github.com", "auth": { "type": "github-app", "app": "code", "repositories": ["acme/api"], "permissions": { "contents": "write", "metadata": "read" } } },
  { "host": "api.github.com", "auth": { "type": "github-app", "app": "code", "repositories": ["acme/api"], "permissions": { "contents": "write", "pull_requests": "write", "metadata": "read" } } }
]}}
```

On `github.com` it goes as git's `Basic x-access-token:<token>`, elsewhere as a
bearer token (`scheme` changes that). `git clone`, `git push` and `curl`
against plain `https://` URLs just work; the machine and the model never hold
the token, and whatever Authorization the machine sends is replaced. Only
GitHub's hosts take this auth: `github.com`, `api.github.com`,
`uploads.github.com`, `codeload.github.com` and `raw.githubusercontent.com`.
GitHub's 403 (what a scoped token may not do) goes back to the machine; a 401
drops the token and the next request gets a new one.

### GitHub channels

A `github` channel can name a stored App with `credentials: {"app": "code"}`
instead of carrying its own App ID, key and secret, so one App answers the
webhooks and mints the agents' tokens. See [Channels](channels.md).

## What the runtime does with tokens

- **Minted, never stored.** A token is kept in the memory of the node that
  minted it, until five minutes before it expires, for the same App, key,
  installation, repositories and permissions; agents that ask for the same
  scope share it, and calls at once share one mint. Each node mints its own.
- **Never shown.** It is not returned by any API, written to a log, an event
  or history, or shown to the model. Errors say what GitHub answered, never a
  credential.
- **Your tenant's only.** An App is found by name or id within the tenant of
  the agent asking; another tenant's App of the same name is never used.
- **Only to GitHub, or where you said.** A token is minted only for a request to
  one of GitHub's hosts or the App's `hosts`.
- **Deleted means stopped.** Each use reads the App's record, so after `DELETE`
  no token is minted or served from it, on any node; the tokens the deleting
  node held are revoked at GitHub, and any other node's lapse within the hour,
  unused. An App a channel uses cannot be deleted until the channel is.
- **Rotated means new tokens.** A key change invalidates the tokens minted
  under the old key.

Account export lists your Apps, masked (`github-apps.json`); deleting the
account deletes them.

## List repositories without copying the App key

An account API token can read the repositories of its registered App:

- `GET /v1/github-apps/{app}/repositories?perPage=100&cursor=...`
  returns `{ items, nextCursor }`. Follow `nextCursor` until it is null, including
  when a page has no items. Pages cross installations; suspended installations
  are skipped. `perPage` is 1–100 (default 100).
- `GET /v1/github-apps/{app}/repositories/{owner}/{name}` checks that the App's
  installation can access this repository. A public repository without an
  installation is not enough. Unavailable repositories return 404.

Repository cursors follow GitHub's live installation and repository pages; they
do not identify a fixed snapshot. Changes to installations or repository access
between requests can skip or repeat items. Deduplicate by repository `id` and
restart the listing when you need a fresh inventory. Keep `perPage` unchanged
while following a cursor.

Each item has `id`, `name`, `fullName`, `private`, `htmlUrl`, and
`defaultBranch`. These are App permissions, not the signed-in user's GitHub
permissions. Enforce your application's membership policy before exposing them.

The runtime reads the tenant's encrypted App credentials and mints installation
tokens with only metadata read permission. It never returns the private key or
installation token. Registration and egress grants continue to use the same
App; these read APIs do not change grants or repository permissions.

TypeScript: `runtime.githubRepositories("code", { cursor, perPage: 100 })`
and `runtime.githubRepository("code", "acme", "app")`.
Python: `runtime.github_repositories("code", cursor=cursor)` and
`runtime.github_repository("code", "acme", "app")`.
