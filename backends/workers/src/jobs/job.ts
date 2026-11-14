/** Resource overrides used by host pricing. */
export type JobSpec = {
  limits?: { cpus?: number; memoryMiB?: number; diskMiB?: number };
};
