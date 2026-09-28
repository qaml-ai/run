<script lang="ts">
  import { agentChat } from "@camelai/agent-runtime-svelte";

  // Demo sign-in: a random user per browser (see server.ts).
  const user = (localStorage.demoUser ??= crypto.randomUUID());
  const { messages, status, send, stop } = agentChat({ endpoint: "/api/agent", headers: { "x-demo-user": user } });
  let text = $state("");
  const submit = (event: SubmitEvent) => { event.preventDefault(); if (text.trim()) void send(text); text = ""; };
</script>

<main style="max-width: 640px; margin: 0 auto; padding: 16px">
  {#each $messages as message (message.id)}
    <div data-role={message.role} style="margin: 8px 0; white-space: pre-wrap">
      <b>{message.role === "user" ? "You" : "Agent"}:</b>
      {#if message.role === "user"}{message.text}
      {:else}{#each message.parts as part (part.id)}{#if part.type === "text"}{part.text}{:else if part.type === "tool"}<i> [{part.name}: {part.state}] </i>{/if}{/each}{/if}
    </div>
  {/each}
  <form onsubmit={submit} style="display: flex; gap: 8px">
    <input bind:value={text} aria-label="Message" placeholder="Message the agent…" style="flex: 1" />
    {#if $status === "streaming" || $status === "submitted"}<button type="button" onclick={() => stop()}>Stop</button>{:else}<button>Send</button>{/if}
  </form>
</main>
