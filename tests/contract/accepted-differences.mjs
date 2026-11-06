/** CTO-reviewed backend differences (2026-11-05, channels 2026-11-06); exact case identities only.
 * Node must still run these assertions. Workers records a separate non-pass status.
 */
export const reasons = Object.freeze({
  sandbox: "Workers code mode uses Pi’s QuickJS remote sandbox by CTO decision; Node uses V8.",
  recovery: "Durable Objects recover their own durable state; ECS-only Postgres pending_runs, versioned headers and resume_failures/resume_after are not the Workers recovery contract.",
  drain: "ECS load balancer keep-alive and drain (timeout=365) are not the Workers transport lifecycle.",
  mailIngress: "ECS receives mail through SES and SNS (signed notifications, S3 for large mail); Workers receives it from Cloudflare Email Routing in its Email Worker, proves senders with DKIM and keeps large mail in R2 itself.",
  channelShortRead: "Workers volumes cannot give a short read: a file's reference size comes from stat on the same stored object that is read back.",
  channelClaims: "Two ECS scanners with distinct node ids race on one channel item claim, fenced by revision; Workers has no scan loop or distinct scanning nodes: a lapsed claim is retaken by the scan its insert scheduled through the queue, or by the cron.",
  channelLeases: "ECS agent ownership and leases (Ownership, LostClaim); Workers has one Durable Object per agent, so there is no lease to lose.",
});

export const acceptedDifferences = Object.freeze([...[
  {"area": "access", "source": "tests/tenant-reads.test.ts:117", "name": "an agent with work left that cannot be loaded is tried again with capped backoff, never for good, and says so", reason: reasons.recovery },
  {"area": "access", "source": "tests/tenant-reads.test.ts:144", "name": "a request whose open-work mark could not be written is not taken, and its retry runs", reason: reasons.recovery },
  {"area": "history", "source": "tests/pi-durable-context-guard.test.ts:107", "name": "an oversized resumed range fails once, clears pending work, and remains readable and abortable", reason: reasons.recovery },
  {"area": "tools", "source": "tests/code-engine.test.ts:21", "name": "codemode runs on V8 for every tenant, and the limits API refuses an engine", reason: reasons.sandbox },
  {"area": "transport", "source": "tests/http-drain.test.ts:15", "name": "idle sockets outlive the load balancer's 360 s; a drain answers a long poll under way in full, with Connection: close", reason: reasons.drain },
 ].map(row => Object.freeze({ ...row, reviewedBy: "CTO", reviewedAt: "2026-11-05" })), ...[
  // Channels came into scope with the Workers channel port; CTO-reviewed 2026-11-06.
  {"area": "channels", "source": "tests/channels-email.test.ts:161", "name": "SNS messages must be signed by SNS for the configured topic; a subscription is confirmed", reason: reasons.mailIngress },
  {"area": "channels", "source": "tests/channels-email.test.ts:287", "name": "mail SES stored in S3 is read from there, and so are its attachments", reason: reasons.mailIngress },
  {"area": "channels", "source": "tests/channels.test.ts:413", "name": "a file that reads back shorter than its reference is never sent: the send fails, is retried, and says what came back", reason: reasons.channelShortRead },
  {"area": "channels", "source": "tests/channels.test.ts:568", "name": "a node whose claim on a message lapsed, and whose send then fails for good, leaves the message to the node that retook it", reason: reasons.channelClaims },
  {"area": "channels", "source": "tests/channels.test.ts:599", "name": "a node that lost an agent sends nothing more for it", reason: reasons.channelLeases },
 ].map(row => Object.freeze({ ...row, reviewedBy: "CTO", reviewedAt: "2026-11-06" }))]);

const key = row => `${row.area}\0${row.source}\0${row.name}`;
const byCase = new Map(acceptedDifferences.map(row => [key(row), row]));

export function acceptedDifference(row, backend) {
  return backend === "workers" ? byCase.get(key(row)) : undefined;
}

export function differenceResult(row) {
  const decision = acceptedDifference(row, "workers");
  if (!decision) throw new Error(`No reviewed difference for ${row.name}`);
  return { ...row, status: "accepted-difference", backend: "workers", reason: decision.reason,
    reviewedBy: decision.reviewedBy, reviewedAt: decision.reviewedAt };
}

export function validateDifferences(rows, backend) {
  for (const row of rows) {
    const decision = acceptedDifference(row, backend);
    if (decision && row.status !== "accepted-difference")
      throw new Error(`Reviewed difference cannot count as ${row.status}: ${row.name}`);
    if (row.status !== "accepted-difference") continue;
    if (!decision || row.backend !== "workers" || row.reason !== decision.reason ||
        row.reviewedBy !== decision.reviewedBy || row.reviewedAt !== decision.reviewedAt)
      throw new Error(`Unreviewed accepted difference: ${row.name}`);
  }
}

export function validateDifferenceInventory(rows) {
  for (const decision of acceptedDifferences) {
    if (rows.filter(row => key(row) === key(decision)).length !== 1)
      throw new Error(`Reviewed difference missing or duplicated in inventory: ${decision.name}`);
  }
}
