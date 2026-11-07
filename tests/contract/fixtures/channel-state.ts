/**
 * Channel cases read and seed the channel tables the same way on both backends (one Postgres schema): a
 * stored channel of a retired type, the queue drained, a delivery's dedup marker, a stored GitHub App's sealed record.
 * Only these tables.
 */
const TABLES = new Set(["github_apps", "channels", "channel_items", "channel_seen", "channel_counts", "channel_conversations", "channel_agents", "email_threads", "email_messages"]);

export function channelQuery(db: { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }) {
  return async (text: string, values: unknown[] = []) => {
    const named = [...text.matchAll(/\b(?:from|into|update|join|table)\s+([a-z_]+)/gi)].map(match => match[1]!.toLowerCase());
    if (!named.length || named.some(name => !TABLES.has(name))) throw new Error(`Channel fixture queries touch only channel tables: ${named.join(", ")}`);
    const { rows, rowCount } = await db.query(text, values);
    return { rows, rowCount };
  };
}
