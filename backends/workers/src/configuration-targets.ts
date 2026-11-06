import { canonical } from "../../../shared/durable-json.ts";
import type { AgentConfiguration } from "./api-contract.ts";

export type ConfigurationTarget = {
  id: string;
  config?: AgentConfiguration;
  params?: Record<string, unknown>;
  replace?: true;
  origin?: string;
};
export type ConfigurationRecord = {
  id: string;
  method: "configure";
  state: "running" | "completed";
  fingerprint: string;
  startedAt: number;
  endedAt?: number;
  outcome?: { result?: { configured: true; changed: boolean; configHash: string }; error?: string };
};
type Host = {
  busy(): Promise<boolean>;
  apply(target: ConfigurationTarget): Promise<{ changed: boolean; configHash: string }>;
  emit(record: ConfigurationRecord): Promise<void>;
};

/** Configuration is durable before acknowledgment and applies in order between turns. */
export class ConfigurationTargets {
  private draining?: Promise<void>;
  private storage: DurableObjectStorage;
  private host: Host;
  constructor(storage: DurableObjectStorage, host: Host) { this.storage = storage; this.host = host; }

  async enqueue(target: ConfigurationTarget): Promise<ConfigurationRecord> {
    const fingerprint = canonical({ method: "configure", params: target.params ?? target.config, ...(target.replace ? { replace: true } : {}) });
    return this.storage.transaction(async tx => {
      const old = await tx.get<ConfigurationRecord>(`request:${target.id}`);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw Object.assign(new Error("Request id reused with different input"), { status: 409 });
        return old;
      }
      const sequence = (await tx.get<number>("configuration-sequence") ?? 0) + 1;
      const record: ConfigurationRecord = { id: target.id, method: "configure", state: "running", fingerprint, startedAt: Date.now() };
      await tx.put("configuration-sequence", sequence);
      await tx.put(`configuration-target:${String(sequence).padStart(16, "0")}`, target);
      await tx.put(`request:${target.id}`, record);
      return record;
    });
  }

  async pending() {
    return (await this.storage.list({ prefix: "configuration-target:", limit: 1 })).size > 0;
  }

  drain(): Promise<void> {
    return this.draining ??= this.process().finally(() => { this.draining = undefined; });
  }

  private async process() {
    for (;;) {
      const [entry] = await this.storage.list<ConfigurationTarget>({ prefix: "configuration-target:", limit: 1 });
      if (!entry || await this.host.busy()) return;
      const [key, target] = entry;
      const record = await this.storage.get<ConfigurationRecord>(`request:${target.id}`);
      if (!record || record.state === "completed") { await this.storage.delete(key); continue; }
      let outcome: ConfigurationRecord["outcome"];
      try { outcome = { result: { configured: true, ...await this.host.apply(target) } }; }
      catch (error) {
        if ((error as { status?: number }).status === 409 && /busy|newer configuration/i.test(String(error))) return;
        outcome = { error: error instanceof Error ? error.message : String(error) };
      }
      const completed: ConfigurationRecord = { ...record, state: "completed", endedAt: Date.now(), outcome };
      await this.storage.transaction(async tx => {
        await tx.put(`request:${target.id}`, completed);
        await tx.delete(key);
      });
      await this.host.emit(completed);
    }
  }
}
