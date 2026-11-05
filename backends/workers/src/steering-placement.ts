type Submission = { id: number; status: string; answer?: number };

/** A live view may outlast its native input's final settlement. */
export function steeringCanJoin(input: Pick<Submission, 'status' | 'answer'> | undefined): boolean {
  return input?.status === 'placed' && input.answer === undefined;
}

/** Pi can place a queued steer at a tool boundary or start its own run after a final answer. */
export function steeringJoined(
  current: Submission | undefined,
  previous: Submission | undefined,
  active: readonly { id: number }[],
  committed = false,
): boolean | undefined {
  // A steer accepted by an actually live logical turn stays in that turn when
  // Pi drains it after an answer, just as the Node host's runInner loop does.
  if (committed) return true;
  if (!current || !previous) return undefined;
  if (active.some(input => input.id === current.id))
    return active.some(input => input.id === previous.id);
  // An observer can receive the placement after the new run already finished.
  // The shared answer is durable evidence that two inputs belonged to one run.
  if (current.answer !== undefined && previous.answer !== undefined)
    return current.answer === previous.answer;
  if (current.status === 'placed' && previous.status === 'done') return false;
  return undefined;
}
