### GitHub Apps: camelRun holds the App's key and mints installation tokens

A tenant can store GitHub Apps (`/v1/github-apps`: App ID, private key, optional webhook secret, a name), sealed with
the secrets key like provider keys and shown masked. `POST /v1/github-apps/manifest` takes the code from GitHub's
manifest flow and stores the App it made, key and webhook secret included. `PATCH` rotates the key (checked with
GitHub first) and `DELETE` stops minting on every node. New table `github_apps` (migration 114); account export
writes `github-apps.json` and account deletion removes the rows.

Definitions ask for a token with `auth: { type: "github-app", app, repositories?, permissions?, owner?, installation? }`
on MCP servers and OpenAPI sources (both backends), and on Workers computer egress grants to GitHub's hosts (git gets
`Basic x-access-token`, the API a bearer token, added by the gateway outside the machine). Tokens are minted by
camelRun (an App JWT, then the installation's access token scoped to the repositories and permissions asked for), kept
in memory until five minutes before they expire, and never stored, logged or returned. They go only to GitHub's hosts
(and GitHub's MCP server) or hosts the App lists (`hosts`, set only with an API key or the console). A GitHub channel can name a
stored App with `credentials: { app }` instead of carrying its own credentials. Guide: `docs/guides/github-apps.md`.
