import { SUBAGENT_EVENTS } from './multi-agent-policy.ts';

/** Child and workflow events are opt-in on every public event transport. */
export function visibleEvent(value: unknown, subagents: boolean): boolean {
  const frame = value as { type?: string; event?: { type?: string } } | null;
  return subagents || frame?.type !== 'event' || !SUBAGENT_EVENTS.includes(frame.event?.type ?? '');
}
