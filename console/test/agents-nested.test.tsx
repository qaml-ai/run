import { describe, expect, it } from "vitest";
import { nested } from "../web/pages/agents";
import type { AgentSummary } from "../web/lib/api";

const agent = (id: string, parentAgentId?: string) => ({ id, name: id, type: "general", model: "m", connected: false, running: false, expiresAt: null, ...(parentAgentId ? { parentAgentId } : {}) }) as AgentSummary;

describe("nested", () => {
  it("lists each sub-agent right under its parent, deeper for each level; one whose parent is gone on its own", () => {
    const rows = nested([agent("child", "lead"), agent("other"), agent("lead"), agent("grandchild", "child"), agent("orphan", "deleted")]);
    expect(rows.map(row => [row.agent.id, row.depth])).toEqual([["other", 0], ["lead", 0], ["child", 1], ["grandchild", 2], ["orphan", 0]]);
  });
});
