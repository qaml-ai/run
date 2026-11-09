import { AsyncLocalStorage } from 'node:async_hooks';

/** Only the apply request uses this connection. Other requests retain their own pool. */
export type ApplySql = { query<R = any>(text: string, values?: any[]): Promise<{ rows: R[]; rowCount: number | null }> };
export const applyScope = new AsyncLocalStorage<{ sql: ApplySql }>();
export const applying = () => !!applyScope.getStore();

/** Request-local preparation survives the rolled-back preview. No network work under the apply lock. */
export const applyPreparation = new AsyncLocalStorage<{ values: Map<string, Promise<unknown>>; locked: boolean }>();
export class ApplyChanged extends Error {
  status = 409;
  constructor() { super('Resources changed during apply validation; retry'); }
}
export async function prepareApply<T>(key: string, prepare: () => Promise<T>): Promise<T> {
  const scope = applyPreparation.getStore();
  if (!scope) return prepare();
  let value = scope.values.get(key);
  if (!value) {
    if (scope.locked) throw new ApplyChanged();
    value = prepare();
    scope.values.set(key, value);
  }
  // Admission preparation returns a callback; configuration values must stay immutable between passes.
  const prepared = await value;
  return (typeof prepared === 'function' ? prepared : structuredClone(prepared)) as T;
}
