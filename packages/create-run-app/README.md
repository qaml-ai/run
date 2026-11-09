# @camelai/create-run-app

Create a Next.js app with a streaming chat to an agent on camelRun:

```sh
export CAMELRUN_API_KEY=art_...   # https://run.camelai.com/console/tokens
npm create @camelai/run-app my-app
cd my-app && npm run dev
```

It writes the key from `CAMELRUN_API_KEY` to the app's `.env.local`. Options: `--api-key` (instead of
the environment variable, though a key on the command line lands in your shell history), `--base-url` (a runtime other than
https://run.camelai.com), `--no-install`. The app has a chat (`<AgentChat>`), its route
(`createAgentHandler`, which keeps your key on the server), a tool drawn with its own component,
GitHub/OIDC sign-in recipes to configure, and an `AGENTS.md` (with a `CLAUDE.md` pointing at it) for coding agents.

Use `--cloudflare` for OpenNext, Wrangler, runtime environment bindings and a webpack production build.
The template includes GitHub org-gated OAuth and OIDC; access stays closed until configured.
Canonical server environment names are `CAMELRUN_API_KEY` and `CAMELRUN_URL`; the older CAMELAI names still work.
