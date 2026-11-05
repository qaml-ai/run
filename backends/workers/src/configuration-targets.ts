import { canonical } from "../../../shared/durable-json.ts";
import type { AgentConfiguration } from "./api-contract.ts";

type Target = { id: string; config: AgentConfiguration; origin?: string };
type Record = { id: string; method: "configure"; state: "queued" | "completed"; fingerprint: string; startedAt: number; endedAt?: number; outcome?: { result?: { configured: true; changed: boolean; configHash: string }; error?: string } };
type Host = {
  busy(): Promise<boolean>;
  apply(target: Target): Promise<{ changed: boolean; configHash: string }>;
  emit(record: Record): Promise<void>;
};

/** A configuration target is durable before acknowledgment and applies between turns. */
export class ConfigurationTargets {
  private draining?: Promise<void>;
  private storage: DurableObjectStorage;
  private host: Host;
  constructor(storage: DurableObjectStorage, host: Host) { this.storage = storage; this.host = host; }
  async enqueue(target: Target): Promise<Record> {
    const fingerprint = canonical(target);
    return this.storage.transaction(async tx => {
      const old = await tx.get<Record>(`request:${target.id}`);
      if (old) {
        if (old.fingerprint !== fingerprint) throw Object.assign(new Error("Request id reused with different configuration"), { status: 409 });
        return old;
      }
      const sequence = (await tx.get<number>("configuration-sequence") ?? 0) + 1;
      const record: Record = { id: target.id, method: "configure", state: "queued", fingerprint, startedAt: Date.now() };
      await tx.put("configuration-sequence", sequence);
      await tx.put(`configuration-target:${String(sequence).padStart(16, "0")}`, target);
      await tx.put(`request:${target.id}`, record);
      return record;
    });
  }
  async pending() { return (await this.storage.list({ prefix: "configuration-target:", limit: 1 })).size > 0; }
  drain(): Promise<void> {
    return this.draining ??= this.process().finally(() => { this.draining = undefined; });
  }
  private async process() {
    for (;;) {
      if (await this.host.busy()) return;
      const [entry] = await this.storage.list<Target>({ prefix: "configuration-target:", limit: 1 });
      if (!entry) return;
      const [key, target] = entry;
      const record = await this.storage.get<Record>(`request:${target.id}`);
      if (!record || record.state === "completed") { await this.storage.delete(key); continue; }
      let outcome: Record["outcome"];
      try { outcome = { result: { configured: true, ...await this.host.apply(target) } }; }
      catch (error) {
        // A turn may enter while a target's model is being resolved. Leave the
        // target in order and retry after that turn rather than losing it.
        if ((error as { status?: number }).status === 409 && /busy|newer configuration/i.test(String(error))) return;
        outcome = { error: error instanceof Error ? error.message : String(error) };
      }
      const completed: Record = { ...record, state: "completed", endedAt: Date.now(), outcome };
      await this.storage.transaction(async tx => {
        await tx.put(`request:${target.id}`, completed);
        await tx.delete(key);
      });
      await this.host.emit(completed);
    }
  }
}
