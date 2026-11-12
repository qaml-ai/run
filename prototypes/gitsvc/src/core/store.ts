// What VolumeCore needs from a git remote (same interface as proto/artifacts-volumes `src/store.ts`, minus the
// Artifacts classes). `GitsvcStore` is the gitsvc implementation: tokens are minted locally from the shared HMAC key
// (the volume object holds it; nothing round-trips to the service), blob reads hit the service's read API.
import { mintToken } from "../token.ts";

export interface Store {
  readonly remote: string;
  token(scope: "read" | "write", ttlSeconds?: number): Promise<{ plaintext: string; expiresAt?: string | number }>;
  readBlob(sha: string): Promise<Uint8Array | null>;
}

export class GitsvcStore implements Store {
  readonly remote: string;
  private readonly base: string;
  private readonly repo: string;
  private readonly key: string;
  /** `base` is the service root (`https://git.internal`), `repo` the repo name; `key` the HMAC signing key. */
  constructor(options: { base: string; repo: string; key: string }) {
    this.base = options.base; this.repo = options.repo; this.key = options.key;
    this.remote = `${options.base}/${options.repo}.git`;
  }
  async token(scope: "read" | "write", ttlSeconds = 600) {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    return { plaintext: mintToken(this.key, { repo: this.repo, scope, exp: expiresAt }), expiresAt };
  }
  async readBlob(sha: string) {
    const token = mintToken(this.key, { repo: this.repo, scope: "read", exp: Math.floor(Date.now() / 1000) + 60 });
    const response = await fetch(`${this.base}/api/repos/${this.repo}/blob/${sha}`, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`blob: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
