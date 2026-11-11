/**
 * Who owns a piece of delegated work: a child agent, an inbox item. Today only agents start children; a workflow
 * (docs/design/swarm-workflows.md) is the second kind. Both are found by kind and id.
 */
export type OwnerKind = "agent" | "workflow";
export type Owner = { kind: OwnerKind; id: string };

const KINDS: readonly OwnerKind[] = ["agent", "workflow"];

export function agentOwner(id: string): Owner {
  return { kind: "agent", id };
}

/** An owner as stored (a JSON object, or a bare agent id as rows written before owners were recorded have it). */
export function ownerOf(value: unknown): Owner | undefined {
  if (typeof value === "string" && value) return agentOwner(value);
  if (!value || typeof value !== "object") return undefined;
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  return typeof id === "string" && id && KINDS.includes(kind as OwnerKind) ? { kind: kind as OwnerKind, id } : undefined;
}

/**
 * Where a child stands in its delegation chain, written once by the runtime when the child is made (or its run is
 * started) and read back as stored: never recomputed by walking agents, never carried as signed prompt metadata.
 * `chain` is the owners above the child, its root first and its owner last.
 */
export type Placement = {
  owner: Owner;
  rootOwner: Owner;
  chain: string[];
  depth: number;
  maxDepth: number;
  /** The owner's call that started the child's run. */
  toolCallId?: string;
  /** The owner's run that started it. */
  ownerRun?: string;
};

export function placementOf(value: unknown): Placement | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const owner = ownerOf(raw.owner), rootOwner = ownerOf(raw.rootOwner);
  if (!owner || !rootOwner || !Array.isArray(raw.chain) || !raw.chain.every(id => typeof id === "string" && id)) return undefined;
  if (!Number.isInteger(raw.depth) || !Number.isInteger(raw.maxDepth)) return undefined;
  return {
    owner, rootOwner, chain: raw.chain as string[], depth: raw.depth as number, maxDepth: raw.maxDepth as number,
    ...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
    ...(typeof raw.ownerRun === "string" ? { ownerRun: raw.ownerRun } : {}),
  };
}

/**
 * A delegation call's identity: `callId` on its first attempt, `callId:attempt` after. A rerun or an abort followed by
 * a re-issue bumps the attempt and makes a new child; attempt 1 is the call id alone, so a child made before attempts
 * existed is found again by the same call.
 */
export function attemptedCall(callId: string, attempt = 1): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("attempt is a positive integer");
  return attempt === 1 ? callId : `${callId}:${attempt}`;
}
