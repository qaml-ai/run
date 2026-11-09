import { HttpError } from './http-error.ts';
import { sha256Hex } from './sha256.ts';

export const MAX_HOOK_BYTES = 1024 * 1024;
export const hookPath = (path: string) => /^\/v1\/hooks(?:\/[^/]+)?$/.test(path);
export function checkHookLength(request: Request) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_HOOK_BYTES))
    throw new HttpError(Number(length) > MAX_HOOK_BYTES ? 413 : 400, 'Invalid hook body length');
}

/** Admission counters, not cached data. Bounded even under a flood of distinct tokens/addresses. */
export class HookAdmission {
  private buckets = new Map<string, { window: number; count: number }>();
  constructor(privateLimit = 600, ipLimit = 1200, capacity = 10000) {
    this.tokenLimit = privateLimit; this.ipLimit = ipLimit; this.capacity = capacity;
  }
  readonly tokenLimit: number;
  readonly ipLimit: number;
  readonly capacity: number;
  private take(key: string, limit: number, now: number) {
    const window = Math.floor(now / 60000);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.capacity) {
        for (const [id, value] of this.buckets) if (value.window < window) this.buckets.delete(id);
        if (this.buckets.size >= this.capacity) throw new HttpError(429, 'Hook ingress is busy');
      }
      this.buckets.set(key, bucket = { window, count: 0 });
    }
    if (bucket.window < window) { bucket.window = window; bucket.count = 0; }
    if (++bucket.count > limit) throw new HttpError(429, 'Too many hook requests');
  }
  async admit(token: string, ip: string, now = Date.now()) {
    this.take(`ip:${await sha256Hex(ip)}`, this.ipLimit, now);
    this.take(`token:${await sha256Hex(token)}`, this.tokenLimit, now);
  }
}
const admission = new HookAdmission();
export async function handleHook(request: Request, ip: string, service: () => Promise<{receive(token: string, request: Request): Promise<{code: number; body: unknown}>}>, limiter: HookAdmission = admission) {
  checkHookLength(request);
  const path = new URL(request.url).pathname;
  const token = path === '/v1/hooks' ? request.headers.get('x-camelrun-hook-token') ?? '' : path.slice('/v1/hooks/'.length);
  await limiter.admit(token, ip);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(404, 'Unknown hook');
  try { return await (await service()).receive(token, request); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    // Never send transport errors containing request URLs to our logs or callers.
    throw new HttpError(503, 'Hook temporarily unavailable');
  }
}
