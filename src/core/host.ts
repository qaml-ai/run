/** Query results retain pg's rowCount shape, including null for statements without a count. */
export type Rows<R = any> = { rows: R[]; rowCount: number | null };

/** A pool or the connection held by a transaction. No pool lifecycle or driver types cross this boundary. */
export interface Sql {
  query<R = any>(text: string, values?: unknown[]): Promise<Rows<R>>;
}

/**
 * A host-bound transaction: `(work, options) => transaction(db, work, options)` on Node.
 * The host holds one connection, commits on success and rolls back on failure. The Node host retries serialization
 * failures and deadlocks up to three attempts. `rerun: false` runs once for work with effects that cannot be repeated.
 */
export type Transaction = <T>(work: (sql: Sql) => Promise<T>, options?: { rerun?: boolean }) => Promise<T>;

/** The time operations used by retry and expiry policies; timer ownership stays with the host. */
export interface Clock {
  now(): number;
  sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>;
}

/** Already-sanitized log lines, matching the runtime's JSON-line sinks. */
export type Log = (line: string) => void;

/** Serialized metric lines, matching src/metrics.ts's sink and Workers' writeMetricLine. */
export type Metrics = (line: string) => void;

/** Explicit configuration values, rather than ambient process.env. */
export type Config = Readonly<Record<string, string | undefined>>;
