type Submission = { id: number; status: string; answer?: number };

/** Pi can place a queued steer at a tool boundary or start its own run after a final answer. */
export function steeringJoined(
  current: Submission | undefined,
  previous: Submission | undefined,
  active: readonly (Submission | undefined)[],
): boolean | undefined {
  if (!current || !previous) return undefined;
  if (active.some(input => input?.id === current.id))
    return active.some(input => input?.id === previous.id);
  // An observer can receive the placement after the new run already finished.
  // The shared answer is durable evidence that two inputs belonged to one run.
  if (current.answer !== undefined && previous.answer !== undefined)
    return current.answer === previous.answer;
  if (current.status === 'placed' && previous.status === 'done') return false;
  return undefined;
}
