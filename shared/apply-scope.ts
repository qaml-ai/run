import { AsyncLocalStorage } from 'node:async_hooks';

/** Only the apply request uses this connection. Other requests retain their own pool. */
export type ApplySql = { query<R = any>(text: string, values?: any[]): Promise<{ rows: R[]; rowCount: number | null }> };
export const applyScope = new AsyncLocalStorage<{ sql: ApplySql }>();
export const applying = () => !!applyScope.getStore();
