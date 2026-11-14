import { HostJob as RepoHostJob } from '../src/jobs/hosts.ts';
import type { JobSpec } from '../src/jobs/job.ts';
export * from './camelfs-worker.ts';
export { default } from './camelfs-worker.ts';

/** Exercise legacy volume sync on hosts while workflow outputs use repo storage. */
export class HostJob extends RepoHostJob {
  override async run(value: unknown) {
    if (!(value as JobSpec | null)?.volume) return super.run(value);
    // Each HostJob object is scoped to one job id. Serve a volume job through legacy host-side sync.
    this.env = { ...this.env, CAMELFS: undefined };
    return super.run(value);
  }
}
