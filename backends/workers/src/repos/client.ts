import type { AgentInvocation } from '../agent-invocation.ts';
import { doWrite } from './do-write.ts';
import type { RepoWrite, WriteResult } from './write-input.ts';
import type { StoragePlane } from './storage.ts';
import type { RepoEnv } from './registry.ts';
import type { RepoDO } from './repo-do.ts';

type RepoRpc<K extends keyof RepoDO> = RepoDO[K] extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>> : never;

export interface RepoClient {
  write(input: RepoWrite, invocation?: AgentInvocation): Promise<WriteResult>;
  info: RepoRpc<'info'>;
  refs: RepoRpc<'refs'>;
  ref: RepoRpc<'ref'>;
  resolve: RepoRpc<'resolve'>;
  createRef: RepoRpc<'createRef'>;
  deleteRef: RepoRpc<'deleteRef'>;
  deleteOwned: RepoRpc<'deleteOwned'>;
  cas: RepoRpc<'cas'>;
  acquire: RepoRpc<'acquire'>;
  renew: RepoRpc<'renew'>;
  release: RepoRpc<'release'>;
  watch: RepoRpc<'watch'>;
  unwatch: RepoRpc<'unwatch'>;
  commit: RepoRpc<'commit'>;
  init: RepoRpc<'init'>;
  delete: RepoRpc<'delete'>;
  // TEMPORARY(R4): the fused tier write and quota B remove these
  blobSize: RepoRpc<'blobSize'>;
  unseenBytes: RepoRpc<'unseenBytes'>;
}

export class DoRepoClient implements RepoClient {
  private readonly stub: DurableObjectStub<RepoDO>;

  constructor(env: RepoEnv, tenant: string, repoId: string, context?: { lineage: string; storage: StoragePlane; sub: string }) {
    this.env = env; this.tenant = tenant; this.repoId = repoId; this.context = context;
    this.stub = env.REPOS.getByName(`${tenant}:${repoId}`);
  }

  private readonly context?: { lineage: string; storage: StoragePlane; sub: string };
  private readonly env: RepoEnv;
  private readonly tenant: string;
  private readonly repoId: string;

  async write(input: RepoWrite, invocation?: AgentInvocation) {
    if (!this.context) throw new Error('Repo write context is required');
    return doWrite({ ...this.context, env: this.env, tenant: this.tenant, repoId: this.repoId, repo: this }, input, invocation);
  }

  async info(...args: Parameters<RepoClient['info']>) { return this.stub.info(...args); }
  async refs(...args: Parameters<RepoClient['refs']>) { return this.stub.refs(...args); }
  async ref(...args: Parameters<RepoClient['ref']>) { return this.stub.ref(...args); }
  async resolve(...args: Parameters<RepoClient['resolve']>) { return this.stub.resolve(...args); }
  async createRef(...args: Parameters<RepoClient['createRef']>) { return this.stub.createRef(...args); }
  async deleteRef(...args: Parameters<RepoClient['deleteRef']>) { return this.stub.deleteRef(...args); }
  async deleteOwned(...args: Parameters<RepoClient['deleteOwned']>) { return this.stub.deleteOwned(...args); }
  async cas(...args: Parameters<RepoClient['cas']>) { return this.stub.cas(...args); }
  async acquire(...args: Parameters<RepoClient['acquire']>) { return this.stub.acquire(...args); }
  async renew(...args: Parameters<RepoClient['renew']>) { return this.stub.renew(...args); }
  async release(...args: Parameters<RepoClient['release']>) { return this.stub.release(...args); }
  async watch(...args: Parameters<RepoClient['watch']>) { return this.stub.watch(...args); }
  async unwatch(...args: Parameters<RepoClient['unwatch']>) { return this.stub.unwatch(...args); }
  async commit(...args: Parameters<RepoClient['commit']>) { return this.stub.commit(...args); }
  async init(...args: Parameters<RepoClient['init']>) { return this.stub.init(...args); }
  async delete(...args: Parameters<RepoClient['delete']>) { return this.stub.delete(...args); }
  async blobSize(...args: Parameters<RepoClient['blobSize']>) { return this.stub.blobSize(...args); }
  async unseenBytes(...args: Parameters<RepoClient['unseenBytes']>) { return this.stub.unseenBytes(...args); }
}
