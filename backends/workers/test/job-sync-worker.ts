import { HostJob as RepoHostJob, type JobHostsEnv } from '../src/jobs/hosts.ts';
export * from './camelfs-worker.ts';
export { default } from './camelfs-worker.ts';

/** Exercise legacy volume sync on hosts while workflow outputs use repo storage. */
export class HostJob extends RepoHostJob {
  constructor(ctx: DurableObjectState, env: JobHostsEnv) {
    super(ctx, { ...env, CAMELFS: undefined });
  }
}
