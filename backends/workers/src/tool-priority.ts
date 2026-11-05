import type { ToolRegistration } from '@earendil-works/pi-durable';

/** Source routing order: the application's tools win collisions with runtime and remote tools. */
export function prioritizedTools(entries: readonly { extension: { name: string }; tool: ToolRegistration }[]): ToolRegistration[] {
  const rank = (name: string) => name === 'camel.application' ? 0 : name === 'camel.files' ? 1 : name === 'camel.sources' ? 3 : 2;
  const seen = new Set<string>();
  return [...entries].sort((left, right) => rank(left.extension.name) - rank(right.extension.name))
    .filter(({ tool }) => { if (seen.has(tool.name)) return false; seen.add(tool.name); return true; }).map(({ tool }) => tool);
}
