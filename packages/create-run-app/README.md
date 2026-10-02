# @camelai/create-run-app

Create a Next.js app with a streaming chat to an agent on camelRun:

```sh
export CAMELAI_API_KEY=art_...   # https://run.camelai.com/console/tokens
npm create @camelai/run-app my-app
cd my-app && npm run dev
```

It writes the key from `CAMELAI_API_KEY` to the app's `.env.local`. Options: `--api-key` (instead of
the environment variable, though a key on the command line lands in your shell history), `--base-url` (a runtime other than
https://run.camelai.com), `--no-install`. The app has a chat (`<AgentChat>`), its route
(`createAgentHandler`, which keeps your key on the server), a tool drawn with its own component, a
demo sign-in to replace with yours, and an `AGENTS.md` (with a `CLAUDE.md` pointing at it) for coding agents.
