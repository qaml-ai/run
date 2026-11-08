const TABLES = new Set(["agent_share_links", "agent_members", "agent_member_days"]);

export function sharedAgentsQuery(db: { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }) {
  return async (text: string, values: unknown[] = []) => {
    const named = [...text.matchAll(/\b(?:from|into|update|join|table)\s+([a-z_]+)/gi)].map(match => match[1]!.toLowerCase());
    if (!named.length || named.some(name => !TABLES.has(name))) throw new Error(`Shared-agent fixture queries touch only membership tables: ${named.join(", ")}`);
    const { rows, rowCount } = await db.query(text, values);
    return { rows, rowCount };
  };
}
