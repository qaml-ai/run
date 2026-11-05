import { SUBAGENT_EVENTS } from './multi-agent-policy.ts';

/** Child and workflow events are opt-in on every public event transport. */
export function visibleEvent(value: unknown, subagents: boolean): boolean {
  const frame = value as { type?: string; event?: { type?: string } } | null;
  return subagents || frame?.type !== 'event' || !SUBAGENT_EVENTS.includes(frame.event?.type ?? '');
}

/** Hidden events still advance a poll cursor, so they are not replayed forever. */
export function visibleReplay<T extends { cursor: number; events: { id: number; data: unknown }[] }>(replay: T, subagents: boolean) {
  return { ...replay, cursor: replay.events.at(-1)?.id ?? replay.cursor,
    events: replay.events.filter(row => visibleEvent(row.data, subagents)) };
}
