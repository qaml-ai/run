<script setup lang="ts">
import { ref } from "vue";
import { useAgentChat } from "@camelai/run-vue";

// Demo sign-in: a random user per browser (see server.ts).
const user = (localStorage.demoUser ??= crypto.randomUUID());
const { messages, status, send, stop } = useAgentChat({ endpoint: "/api/agent", headers: { "x-demo-user": user } });
const text = ref("");
const submit = () => { if (text.value.trim()) void send(text.value); text.value = ""; };
</script>

<template>
  <main style="max-width: 640px; margin: 0 auto; padding: 16px">
    <div v-for="message in messages" :key="message.id" :data-role="message.role" style="margin: 8px 0; white-space: pre-wrap">
      <b>{{ message.role === "user" ? "You" : "Agent" }}:</b>
      <template v-if="message.role === 'user'">{{ message.text }}</template>
      <template v-else v-for="part in message.parts" :key="part.id">
        <span v-if="part.type === 'text'">{{ part.text }}</span>
        <i v-else-if="part.type === 'tool'"> [{{ part.name }}: {{ part.state }}] </i>
      </template>
    </div>
    <form @submit.prevent="submit" style="display: flex; gap: 8px">
      <input v-model="text" aria-label="Message" placeholder="Message the agent…" style="flex: 1" />
      <button v-if="status === 'streaming' || status === 'submitted'" type="button" @click="stop()">Stop</button>
      <button v-else>Send</button>
    </form>
  </main>
</template>
