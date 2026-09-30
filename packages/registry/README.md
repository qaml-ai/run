# shadcn registry

Tailwind versions of the agent chat, in shadcn/ui's tokens and components, to copy into a project
and own:

```sh
npx shadcn add https://agents.camelai.dev/r/agent-chat.json      # components/agent-chat/*
npx shadcn add https://agents.camelai.dev/r/agent-markdown.json  # just the markdown renderer
npx shadcn add https://agents.camelai.dev/r/agent-route.json     # app/api/agent/route.ts (Next.js)
```

They use the hooks from `@camelai/run-react` (installed with them). Sources are in `src/`;
after changing them, run `npm run registry` (writes `public/r/*.json`; a test fails when those are
stale).
