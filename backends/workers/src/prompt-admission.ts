import type { RunLimitsSnapshot } from "./run-limits.ts";

/** Admission held while files are prepared, before raw request data can be discarded. */
export const PROMPT_PREPARATION_PREFIX = "prompt-preparation:";
const PREPARATION_LEASE_MS = 30 * 60_000;

export type PromptPreparation = {
  tenant: string;
  agent: string;
  requestId: string;
  fingerprint: string;
  expiresAt: number;
  admitted: boolean;
  limitsSnapshot?: RunLimitsSnapshot;
};
type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;

export class PromptPreparations {
  private active = new Set<string>();
  private storage: Storage;
  private release: (receipt: PromptPreparation) => Promise<void>;
  constructor(storage: Storage, release: (receipt: PromptPreparation) => Promise<void>) {
    this.storage = storage;
    this.release = release;
  }

  async begin(input: Omit<PromptPreparation, "expiresAt" | "admitted" | "limitsSnapshot">, admit: () => Promise<RunLimitsSnapshot>, now = Date.now()) {
    const key = PROMPT_PREPARATION_PREFIX + input.requestId;
    let receipt = await this.storage.get<PromptPreparation>(key);
    if (receipt && receipt.fingerprint !== input.fingerprint)
      throw Object.assign(new Error("Request id reused with different input"), { status: 409 });
    this.active.add(input.requestId);
    try {
      // A crash before admission was acknowledged is ambiguous. Release any
      // acquired slot before trying again; never leave an invisible busy agent.
      if (receipt && !receipt.admitted) {
        await this.release(receipt);
        await this.storage.delete(key);
        receipt = undefined;
      }
      if (!receipt) {
        receipt = { ...input, expiresAt: now + PREPARATION_LEASE_MS, admitted: false };
        await this.storage.put(key, receipt);
        receipt = { ...receipt, admitted: true, limitsSnapshot: await admit() };
        await this.storage.put(key, receipt);
      }
      return receipt.limitsSnapshot;
    } catch (error) {
      await this.fail(input.requestId);
      throw error;
    }
  }

  /** The sanitized request now owns this admission. */
  async finish(requestId: string) {
    this.active.delete(requestId);
    await this.storage.delete(PROMPT_PREPARATION_PREFIX + requestId);
  }

  async fail(requestId: string) {
    this.active.delete(requestId);
    const key = PROMPT_PREPARATION_PREFIX + requestId;
    const receipt = await this.storage.get<PromptPreparation>(key);
    if (!receipt) return;
    await this.release(receipt);
    await this.storage.delete(key);
  }

  async sweep(now = Date.now(), restarted = false) {
    for (const [key, receipt] of await this.storage.list<PromptPreparation>({ prefix: PROMPT_PREPARATION_PREFIX })) {
      if (this.active.has(receipt.requestId) || (!restarted && receipt.expiresAt > now)) continue;
      const request = await this.storage.get<{ admitted?: boolean; fingerprint?: string }>(`request:${receipt.requestId}`);
      // The request/receipt handoff can itself be interrupted after request.put.
      if (!request?.admitted || request.fingerprint !== receipt.fingerprint) await this.release(receipt);
      await this.storage.delete(key);
    }
  }

  async deadline() {
    const receipts = await this.storage.list<PromptPreparation>({ prefix: PROMPT_PREPARATION_PREFIX });
    return Math.min(Infinity, ...[...receipts.values()].map(receipt => receipt.expiresAt));
  }

  async cancel() {
    for (const receipt of (await this.storage.list<PromptPreparation>({ prefix: PROMPT_PREPARATION_PREFIX })).values()) {
      await this.storage.put(`cancelled-request:${receipt.requestId}`, true);
      await this.fail(receipt.requestId);
    }
  }
}
