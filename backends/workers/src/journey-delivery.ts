type Sender = { send(): Promise<void> };
type Flush = { again: boolean; promise: Promise<void> };
const inFlight = new WeakMap<Sender, Flush>();

/** Workers have no polling timer to pick up a flush skipped during another send. */
export function flushJourney(journey: Sender): Promise<void> {
  const current = inFlight.get(journey);
  if (current) {
    current.again = true;
    return current.promise;
  }
  let state: Flush;
  const promise = Promise.resolve().then(async () => {
    try {
      do {
        state.again = false;
        await journey.send();
      } while (state.again);
    } finally {
      inFlight.delete(journey);
    }
  });
  state = { again: false, promise };
  inFlight.set(journey, state);
  return promise;
}
