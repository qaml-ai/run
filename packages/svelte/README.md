# @camelai/agent-runtime-svelte

Svelte stores for a chat with an agent on the camelAI agent runtime, through your server's route
(`createAgentHandler` from `@camelai/agent-runtime/server`; see the Frontend guide). They follow the
store contract, so they work in Svelte 4 and 5 (`$messages`), and have no dependency on Svelte.

```svelte
<script lang="ts">
  import { agentChat } from "@camelai/agent-runtime-svelte";
  const { messages, status, send, stop } = agentChat({ endpoint: "/api/agent" });
  let text = "";
</script>

{#each $messages as message (message.id)}
  {#if message.role === "user"}<p>{message.text}</p>
  {:else}{#each message.parts as part (part.id)}{#if part.type === "text"}<p>{part.text}</p>{/if}{/each}{/if}
{/each}
<form on:submit|preventDefault={() => { send(text); text = ""; }}><input bind:value={text} /><button>Send</button></form>
{#if $status === "streaming"}<button on:click={() => stop()}>Stop</button>{/if}
```

`agentChat(options | chat)` returns stores (`messages`, `status`, `inputs`, `error`, `hasOlder`,
`snapshot`) and actions (`send`, `answer`, `decline`, `stop`, `retry`, `loadOlder`, `fileUrl`). The
chat connects with the first subscriber and disconnects after the last.
