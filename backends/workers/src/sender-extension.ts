import { GenerationTask, hook, type Extension } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';
import { renderMessages, type Stamp } from './sender.ts';

/** Render source markers only for the provider; the durable public transcript stays unmodified. */
export function senderExtension(): Extension {
  return { name: 'camel.sender', hooks: [hook(GenerationTask, {
    beforeRequest: async (request, api, context) => {
      const users = new Set(request.messages.filter(message => message.role === 'user').map(message => message.timestamp));
      const marks = new Map<number, Stamp>();
      let cursor;
      // The model's context is usually a small tail, even when history is large.
      // Page backwards and stop as soon as all its user messages have a stamp.
      do {
        const page = await api.entries({ order: 'descending' }, 128, cursor, context);
        for (const entry of page.items) for (const message of entry.model ?? []) if (message.role === 'user' && users.delete(message.timestamp)) {
          if (entry.kind === 'camel.prompt' || entry.kind === 'camel.steer') {
            const { from, requestId, metadata, source } = entry.data as Stamp;
            marks.set(message.timestamp, { from, requestId, metadata, source });
          }
        }
        cursor = page.next;
      } while (users.size && cursor !== undefined);
      const messages = request.messages.map(message => message.role === 'user' ? { ...message, ...marks.get(message.timestamp) } as Message : message);
      return { messages: renderMessages(messages) };
    },
  })] };
}
