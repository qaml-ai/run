import { DurableObject } from "cloudflare:workers";
import type { CamelAgent } from "./agent.ts";
import { BadRequest, boundedText } from "./validation.ts";
import { configuration, digest, ApiError, type AgentConfiguration } from "./api-contract.ts";
export { configuration, digest, ApiError, agentToken } from "./api-contract.ts";

export interface DirectoryEntry {
  id: string;
  key: string | null;
  config: AgentConfiguration;
  configHash: string;
  createdAt: number;
  expiresAt: number | null;
  revision: number;
  initialized: boolean;
  deleted?: true;
  cleanupPending?: boolean;
}
interface DirectoryEnv { AGENTS: DurableObjectNamespace<CamelAgent>; API_TOKEN: string; MODEL: string }
export interface DirectoryFailure { failed: true; status: number; error: string; code: string }

/** Operator-scoped directory; secrets remain in Worker bindings, never in metadata. */
export class AgentDirectory extends DurableObject<DirectoryEnv> {
  async upsert(input: unknown, suppliedKey?: string): Promise<DirectoryEntry | DirectoryFailure> {
    const { config } = configuration(input, this.env.MODEL);
    const key = suppliedKey === undefined ? null : boundedText(suppliedKey, "Idempotency-Key", 80);
    if (key !== null && !/^[A-Za-z0-9_-]+$/.test(key)) throw new BadRequest("Invalid Idempotency-Key");
    const id = `client_${(await digest(key === null ? crypto.randomUUID() : `prototype:${key}`)).slice(0, 40)}`;
    const configHash = await digest(JSON.stringify(config));
    return this.ctx.blockConcurrencyWhile(async () => {
      const previous = await this.ctx.storage.get<DirectoryEntry>(id);
      if (previous?.deleted || previous?.expiresAt && previous.expiresAt <= Date.now()) return { failed: true, status: 410, error: "Agent is deleted or expired", code: "AGENT_GONE" };
      const pending = await this.ctx.storage.get<DirectoryEntry>(`pending:${id}`);
      const changed = previous?.configHash !== configHash;
      // A pending write may have reached the agent before a directory restart.
      // Retry its revision for the same desired config; advance for a new one.
      const entry: DirectoryEntry = previous && !changed && !pending ? previous : {
        id, key, config, configHash,
        createdAt: previous?.createdAt ?? Date.now(),
        expiresAt: previous ? previous.expiresAt : null,
        revision: pending?.configHash === configHash ? pending.revision : Math.max(previous?.revision ?? 0, pending?.revision ?? 0) + 1,
        initialized: false,
      };
      // Persist intent before calling another object: retries repair an interrupted initialization.
      if (!entry.initialized) await this.ctx.storage.put(`pending:${id}`, entry);
      if (!entry.initialized) {
        const response = await this.env.AGENTS.getByName(id).fetch(new Request("https://agent/configuration", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, config, revision: entry.revision, expiresAt: entry.expiresAt }),
        }));
        if (!response.ok) return { failed: true, status: response.status, error: "Agent configuration was refused", code: "CONFIGURATION_FAILED" };
        entry.initialized = true;
        await this.ctx.storage.put(id, entry);
        await this.ctx.storage.delete(`pending:${id}`);
      }
      return entry;
    });
  }

  async get(keyOrId: string): Promise<DirectoryEntry | null> {
    const id = /^client_[a-f0-9]{40}$/.test(keyOrId) ? keyOrId : `client_${(await digest(`prototype:${keyOrId}`)).slice(0, 40)}`;
    return await this.ctx.storage.get<DirectoryEntry>(id) ?? null;
  }

  async list(): Promise<DirectoryEntry[]> {
    const entries = await this.ctx.storage.list<DirectoryEntry>({ prefix: "client_", limit: 1000 });
    return [...entries.values()].filter(entry => !entry.deleted && (!entry.expiresAt || entry.expiresAt > Date.now()));
  }

  async remove(id: string): Promise<boolean | DirectoryFailure> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const entry = await this.ctx.storage.get<DirectoryEntry>(id);
      if (!entry || entry.deleted && !entry.cleanupPending) return false;
      // Revoke access first. Runtime cleanup may be retried without resurrecting the key.
      entry.deleted = true;
      entry.cleanupPending = true;
      await this.ctx.storage.put(id, entry);
      const response = await this.env.AGENTS.getByName(id).fetch(new Request("https://agent/", { method: "DELETE" }));
      if (!response.ok) return { failed: true, status: 503, error: "Agent revoked; cleanup must be retried", code: "CLEANUP_PENDING" };
      entry.cleanupPending = false;
      entry.config = {};
      entry.configHash = "";
      entry.key = null;
      await this.ctx.storage.put(id, entry);
      await this.ctx.storage.delete(`pending:${id}`);
      return true;
    });
  }
}
