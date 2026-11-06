/** Wait for the public request record, which may finish before its model task
 * (for example when a tool asks for human input). Subscribe before reading so
 * a completion committed during the read cannot be missed. */
export async function waitForRequest<T extends { state: string }>(
  read: () => Promise<T>,
  subscribe: (wake: () => void) => () => void,
  milliseconds: number,
  signal: AbortSignal,
): Promise<T> {
  let expired = signal.aborted || milliseconds <= 0;
  let wake = () => {};
  const stop = () => { expired = true; wake(); };
  const unsubscribe = subscribe(() => wake());
  const timer = setTimeout(stop, milliseconds);
  signal.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      const changed = new Promise<void>(resolve => { wake = resolve; });
      const record = await read();
      if (record.state === 'completed' || expired) return record;
      await changed;
    }
  } finally {
    clearTimeout(timer);
    unsubscribe();
    signal.removeEventListener('abort', stop);
  }
}
