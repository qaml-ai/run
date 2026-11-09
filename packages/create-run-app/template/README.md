# Agent app

> Sign-in is closed until GitHub or OIDC is configured. See Authentication below.

A Next.js app with a streaming chat to an agent on [camelRun](https://run.camelai.com).

```sh
npm install
npm run dev                  # http://localhost:3000
```

`.env.local` holds your key: `npm create @camelai/run-app` wrote it from `CAMELRUN_API_KEY`. Without one, add
`CAMELRUN_API_KEY=art_…` to it (create a key at https://run.camelai.com/console/tokens), and
`CAMELRUN_URL=…` for a self-hosted runtime.

The agent uses your account's default model. To choose another, set `AGENT_MODEL` in `.env.local` to
one your account can use: `npx -y @camelai/camelrun models --available` lists them.

Coding agents working in this app: see `AGENTS.md`.

- `app/api/agent/route.ts`: the route the chat talks to (`createAgentHandler`). It keeps your API key on
  the server, makes each user their own agent, and defines its instructions and tools. Configure the
  sign-in in `lib/auth.ts` or use the included recipes.
- `app/components/chat.tsx`: the chat (`<AgentChat>`), with `get_weather` drawn by your own component.
  Theme it with CSS variables (`--agent-accent`, `--agent-radius`, …), or build your own UI with the hooks
  in `@camelai/run-react` (`useMessages`, `useSend`, `useAgentStatus`, `useInputs`).

Tools in `route.ts` run inside this server, so they need a long-running process (`next dev`,
`next start`, a container). On serverless hosting, serve them with `serveTools` (with your `tenant`) from
`@camelai/run/server` and name them in a definition (`agent: { definition: "def_…" }`).

## Authentication

Access is closed until sign-in is configured, in development too. Set `APP_URL` to the app's exact
public origin and `SESSION_SECRET` to at least 32 random characters. Never use a NEXT_PUBLIC secret.
Copy the variable names from `.env.example` into `.env.local`; do not commit values.

For GitHub set `AUTH_PROVIDER=github`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_ORG`.
Register `${APP_URL}/auth/callback` as the OAuth callback. Sign-in requires active org membership;
lookup failures deny access. Membership is checked at login; sessions expire after eight hours.
For OIDC set `AUTH_PROVIDER=oidc`, `OIDC_ISSUER` (HTTPS), `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
Register the same callback. Configure access restrictions at your identity provider. The recipe validates
issuer, audience, signature, expiry, nonce, state and PKCE via openid-client.

Replace `lib/auth.ts`'s `authorize` to use another provider. Return `{userId, name}` from a verified
server session or null. Never accept identity from request JSON. Send POST `/auth/logout` with the
same Origin to clear the session. Sessions are signed, expiring HttpOnly/SameSite=Lax cookies,
Secure on HTTPS; provider access tokens are discarded after login.

## Existing agents

Replace the route's `agent` option with `existingAgent: "agent-id-or-key"`, or a function of the
authorized user. This reads credentials without creating, updating or attaching tools. Check that the
user may access that agent in `authorize`; do not let a browser select an arbitrary tenant agent.
Passing `agent` explicitly opts into provisioning and reconfiguration.

## Cloudflare Workers

Generate with `npm create @camelai/run-app web -- --cloudflare`. Run commands inside `web/`.
`npm run build:worker` builds with webpack and OpenNext; `npm run preview` previews locally.
Keep this directory as the standalone root even when importing shared code from a parent directory.
Development's `turbopack.root` is explicit to avoid inference from a parent lockfile.

Set non-secret configuration (`APP_URL`, `AUTH_PROVIDER`, `GITHUB_ORG`, provider client id/issuer)
in wrangler.jsonc's vars. Set secrets with `npx wrangler secret put CAMELRUN_API_KEY`,
`npx wrangler secret put SESSION_SECRET` and the chosen provider's client secret. For local preview
use an ignored `.dev.vars`. `lib/env.ts` reads Worker bindings at request time; secrets are not built
into the browser bundle. `npm run deploy` deploys only when you choose to run it.
The Cloudflare variant omits local callback tools, which need a persistent server. Set
`AGENT_DEFINITION` to use externally served tools, or `AGENT_ID` to open an already configured agent.
An AGENT_ID is shared by signed-in users, so use it only when all admitted users may access it. See the installed frontend guide.
