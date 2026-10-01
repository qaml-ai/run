# @camelai/create-run-app

Create a Next.js app with a streaming chat to an agent on camelRun:

```sh
npm create @camelai/run-app my-app -- --api-key $CAMELAI_API_KEY
cd my-app && npm run dev
```

Options: `--api-key` (default: `CAMELAI_API_KEY`), `--base-url` (a runtime other than
https://run.camelai.com), `--no-install`. The app has a chat (`<AgentChat>`), its route
(`createAgentHandler`, which keeps your key on the server), a tool drawn with its own component, a
demo sign-in to replace with yours, and an `AGENTS.md` (with a `CLAUDE.md` pointing at it) for coding agents.
