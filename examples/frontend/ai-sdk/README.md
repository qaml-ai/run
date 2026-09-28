# ai-sdk

The AI SDK's `useChat` with an agent: `AgentRuntimeChatTransport` from `@camelai/agent-runtime/ai-sdk` talks to
the same route (`createAgentHandler`, here in Express), so anything built on `useChat` (AI Elements, say) works
with it. The agent keeps the conversation: `useChat`'s `id` is the route's thread, only the new message is sent,
and `loadMessages` reads the history back.

```sh
npm install
export CAMELAI_API_KEY=art_...   # and CAMELAI_MODEL=provider/model if you want another model
npm run dev          # http://localhost:3000
```

Tool calls arrive as `dynamic-tool` parts; approvals as tool approval requests (answer with
`addToolApprovalResponse`, and pass `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`).
The sign-in is a demo: replace `authorize` in `server.ts` with yours.
