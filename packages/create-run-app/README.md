# @camelai/create-run-app

Create a Next.js app with a streaming chat to an agent on camelRun:

```sh
npm create @camelai/run-app my-app -- --api-key $CAMELAI_API_KEY
cd my-app && npm run dev
```

Options: `--api-key` (default: `CAMELAI_API_KEY`), `--base-url` (a runtime other than
https://agents.camelai.dev), `--no-install`. The app has a chat (`<AgentChat>`), its route
(`createAgentHandler`, which keeps your key on the server), a tool drawn with its own component, and a
demo sign-in to replace with yours.
