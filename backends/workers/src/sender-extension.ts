import { GenerationTask, hook, type Extension } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';
import { renderMessages, type Stamp } from './sender.ts';

/** Render source markers only for the provider; the durable public transcript stays unmodified. */
export function senderExtension(): Extension {
  return { name: 'camel.sender', hooks: [hook(GenerationTask, {
    beforeRequest: async (request, api, context) => {
      // Messages Pi places in one commit share a timestamp (a batch's follow-ups, steers appended with a prompt): each
      // timestamp's stamps are matched to its messages in order, not the last one to all of them.
      const wanted = new Map<number, number>();
      for (const message of request.messages) if (message.role === 'user') wanted.set(message.timestamp, (wanted.get(message.timestamp) ?? 0) + 1);
      const marks = new Map<number, (Stamp | undefined)[]>();
      const short = () => [...wanted].some(([timestamp, count]) => (marks.get(timestamp)?.length ?? 0) < count);
      let cursor;
      // The model's context is usually a small tail, even when history is large.
      // Page backwards and stop as soon as all its user messages have a stamp.
      do {
        const page = await api.entries({ order: 'descending' }, 128, cursor, context);
        for (const entry of page.items) for (const message of [...entry.model ?? []].reverse()) if (message.role === 'user' && wanted.has(message.timestamp)) {
          const found = marks.get(message.timestamp) ?? [];
          if (found.length >= wanted.get(message.timestamp)!) continue;
          const stamped = entry.kind === 'camel.prompt' || entry.kind === 'camel.steer';
          const { from, requestId, metadata, source } = (stamped ? entry.data : {}) as Stamp;
          found.unshift(stamped ? { from, requestId, metadata, source } : undefined);
          marks.set(message.timestamp, found);
        }
        cursor = page.next;
      } while (short() && cursor !== undefined);
      const seen = new Map<number, number>();
      const messages = request.messages.map(message => {
        if (message.role !== 'user') return message;
        const index = seen.get(message.timestamp) ?? 0;
        seen.set(message.timestamp, index + 1);
        return { ...message, ...marks.get(message.timestamp)?.[index] } as Message;
      });
      return { messages: renderMessages(messages) };
    },
  })] };
}
