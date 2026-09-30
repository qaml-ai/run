# @camelai/run-vue

Vue 3 bindings for a chat with an agent on camelRun, through your server's route
(`createAgentHandler` from `@camelai/run/server`; see the Frontend guide).

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useAgentChat } from "@camelai/run-vue";

const { messages, status, send, stop } = useAgentChat({ endpoint: "/api/agent" });
const text = ref("");
</script>

<template>
  <div v-for="message in messages" :key="message.id">
    <p v-if="message.role === 'user'">{{ message.text }}</p>
    <template v-else v-for="part in message.parts" :key="part.id">
      <p v-if="part.type === 'text'">{{ part.text }}</p>
      <small v-else-if="part.type === 'tool'">{{ part.name }}: {{ part.state }}</small>
    </template>
  </div>
  <form @submit.prevent="send(text); text = ''"><input v-model="text" /><button>Send</button></form>
  <button v-if="status === 'streaming'" @click="stop()">Stop</button>
</template>
```

`useAgentChat(options | chat)` returns refs (`messages`, `status`, `inputs`, `error`, `hasOlder`,
`snapshot`) and actions (`send`, `answer`, `decline`, `stop`, `retry`, `loadOlder`, `fileUrl`); the chat
is connected until the component unmounts. `provideAgentChat` / `useAgent` share one chat with
descendants. Render markdown with `parseMarkdown` from `@camelai/run/markdown`.
