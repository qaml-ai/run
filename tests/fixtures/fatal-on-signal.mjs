// Preloaded into a test's runtime process: SIGUSR2 throws an error nothing catches (SIGUSR1 starts the inspector), and
// SIGWINCH leaves a rejection nothing handles, as a bug would.
process.on("SIGUSR2", () => setImmediate(() => { throw new Error("a bug nothing caught"); }));
process.on("SIGWINCH", () => void Promise.reject(new Error("a rejection nothing handled")));
