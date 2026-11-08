export type InboxSeed = { id: string; tenant?: string; agent?: string; root?: string; subject?: string; responders?: string[];
  priority?: 'urgent' | 'high' | 'normal' | 'low'; kind?: string; state?: string; createdAt?: number; expiresAt?: number; deferExpiry?: boolean };
export async function seedInbox(db: { query(text: string, values?: any[]): Promise<unknown> }, rows: InboxSeed[]) {
  for (const row of rows) {
    const priority = row.priority ?? 'normal';
    await db.query(`insert into agent_inputs(id, tenant, agent, request_id, tool_call_id, kind, state, input, created_at, expires_at,
      priority, priority_rank, responders, root_agent, subject, claimed_until) values($1,$2,$3,'run','call',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,case when $14 then now() + interval '1 hour' else null end)`,
    [row.id, row.tenant ?? 'alice', row.agent ?? 'lead-a', row.kind ?? 'question', row.state ?? 'pending',
      JSON.stringify({ message: row.id, detail: {}, responders: { audience: row.responders ?? [] }, tool: 'ask_user', argumentsHash: 'hash', requestState: 'private' }),
      row.createdAt ?? 1, row.expiresAt ?? Date.now() + 3600000, priority, ['urgent', 'high', 'normal', 'low'].indexOf(priority), row.responders ?? [], row.root ?? null, row.subject ?? null, row.deferExpiry ?? false]);
  }
}
