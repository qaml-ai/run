/** A sibling wait presents its selected children's progress or ending in this same model step. */
export function waitsForProgress(messages: readonly { role: string; content: unknown }[], child: { id: string; name: string }): boolean {
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== 'toolCall' || part.name !== 'wait_agent') continue;
      const names = part.arguments?.agents;
      if (names === undefined || Array.isArray(names) && names.some(name => name === child.id || name === child.name)) return true;
    }
  }
  return false;
}
