import { AwsClient } from 'aws4fetch';
import { HttpError } from '../errors.ts';
import { paths, MICROVM_MAX_SECONDS } from './microvm-policy.ts';
import type { ComputerDriver, Reference } from './policy.ts';

export interface MicrovmBindings {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  AWS_REGION?: string;
  MICROVM_IMAGE?: string;
  MICROVM_IMAGE_VERSION?: string;
  MICROVM_IDLE_SECONDS?: string;
  /** Only the test harness may redirect the Lambda API to a loopback fake. */
  TEST_MICROVM_ENDPOINT?: string;
  TEST_MODE?: string;
}
export type Fetcher = (request: Request) => Promise<Response>;
export function testEndpoint(value: string | undefined, env: { TEST_MODE?: string }): URL | undefined {
  if (!value) return;
  const url = new URL(value);
  if (env.TEST_MODE !== '1' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash)
    throw new HttpError(503, 'Invalid test provider endpoint');
  return url;
}
export async function boundedResponse(response: Response, limit = 2 * 1024 * 1024): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new Error('Computer provider response exceeds limit');
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
}
export function microvmApi(env: MicrovmBindings, send: Fetcher = request => fetch(request)) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_REGION)
    throw new HttpError(503, 'Managed Lambda computers are not configured');
  const signer = new AwsClient({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN, service: 'lambda', region: env.AWS_REGION, retries: 0 });
  const base = testEndpoint(env.TEST_MICROVM_ENDPOINT, env) ?? new URL(`https://lambda.${env.AWS_REGION}.amazonaws.com`);
  return async (operation: string, input: Record<string, unknown> = {}) => {
    const route = paths[operation];
    if (!route) throw new Error('Unknown MicroVM operation');
    const [method, suffix] = route, { microvmIdentifier, ...payload } = input;
    if (suffix && (typeof microvmIdentifier !== 'string' || !microvmIdentifier)) throw new Error('Missing MicroVM ID');
    const url = new URL(`/2025-09-09/microvms${suffix.replace('{id}', encodeURIComponent(String(microvmIdentifier)))}`, base);
    if (method === 'GET') for (const [key, value] of Object.entries(payload)) url.searchParams.set(key, String(value));
    const request = await signer.sign(url, { method, headers: { 'content-type': 'application/json' }, redirect: 'manual',
      signal: AbortSignal.timeout(30_000), ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}) });
    const response = await send(request), raw = await boundedResponse(response, 4 * 1024 * 1024);
    if (!response.ok) throw Object.assign(new Error(`MicroVM API HTTP ${response.status}`), { status: response.status });
    return raw ? JSON.parse(raw) : {};
  };
}

/** No AWS SDK/default credential chain: every request is signed with Worker secrets. */
export function microvmDriver(env: MicrovmBindings, tenant: string, send: Fetcher = request => fetch(request)): ComputerDriver {
  const api = microvmApi(env, send);
  if (!env.MICROVM_IMAGE) throw new HttpError(503, 'Managed Lambda image is not configured');
  const idle = Number(env.MICROVM_IDLE_SECONDS ?? '300');
  if (!Number.isInteger(idle) || idle < 60 || idle > 3600) throw new HttpError(503, 'Invalid MicroVM idle timeout');
  const proxy = async (ref: Reference, path: string, body?: unknown) => {
    const endpoint = new URL(String(ref.endpoint));
    const fake = testEndpoint(env.TEST_MICROVM_ENDPOINT, env);
    if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      (fake ? endpoint.origin !== fake.origin : endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.amazonaws.com')))
      throw new Error('Invalid MicroVM endpoint');
    const token = await api('CreateMicrovmAuthToken', { microvmIdentifier: ref.id, expirationInMinutes: 60, allowedPorts: [{ port: 8080 }] });
    if (!token.authToken || typeof token.authToken !== 'object' || Object.values(token.authToken).some(x => typeof x !== 'string')) throw new Error('Invalid MicroVM token');
    const response = await send(new Request(new URL(path, endpoint), { method: body === undefined ? 'GET' : 'POST',
      headers: { ...token.authToken, 'X-aws-proxy-port': '8080', 'content-type': 'application/json' }, redirect: 'manual',
      signal: AbortSignal.timeout(35_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const raw = await boundedResponse(response, 1024 * 1024);
    if (!response.ok) throw new Error(`MicroVM agent HTTP ${response.status}`);
    return { status: response.status, value: JSON.parse(raw) };
  };
  return {
    refused: error => [401, 403, 429].includes(Number((error as { status?: number })?.status)),
    async create(id, seconds, allocated) {
      const vm = await api('RunMicrovm', { imageIdentifier: env.MICROVM_IMAGE,
        ...(env.MICROVM_IMAGE_VERSION ? { imageVersion: env.MICROVM_IMAGE_VERSION } : {}),
        idlePolicy: { maxIdleDurationSeconds: idle, suspendedDurationSeconds: MICROVM_MAX_SECONDS, autoResumeEnabled: true },
        maximumDurationInSeconds: Math.min(seconds, MICROVM_MAX_SECONDS), clientToken: id,
        logging: { disabled: {} }, runHookPayload: JSON.stringify({ runtime: 'workers', computer: id, tenant }) });
      if (typeof vm.microvmId !== 'string' || typeof vm.endpoint !== 'string') throw new Error('Incomplete MicroVM launch response');
      const ref = { id: vm.microvmId, endpoint: vm.endpoint.startsWith('http') ? vm.endpoint : `https://${vm.endpoint}` };
      await allocated?.(ref);
      await proxy(ref, '/health');
      return ref;
    },
    async call(ref, _operation, args) {
      const key = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(args.requestKey)));
      const requestKey = Array.from(new Uint8Array(key), x => x.toString(16).padStart(2, '0')).join('');
      let result = await proxy(ref, '/exec', { command: args.command, timeoutSeconds: args.timeoutSeconds, requestKey });
      const until = Date.now() + (Number(args.timeoutSeconds) + 60) * 1000;
      while (result.status === 202 && Date.now() < until) result = await proxy(ref, `/exec/${requestKey}?wait=25`);
      if (result.status !== 200 || !Number.isInteger(result.value.exitCode) || typeof result.value.stdout !== 'string' || typeof result.value.stderr !== 'string')
        throw new Error('Incomplete MicroVM command result');
      return { exitCode: result.value.exitCode, stdout: result.value.stdout.slice(0, 65536), stderr: result.value.stderr.slice(0, 65536),
        truncated: !!result.value.truncated || result.value.stdout.length > 65536 || result.value.stderr.length > 65536 };
    },
    async close(ref) {
      try {
        await api('TerminateMicrovm', { microvmIdentifier: ref.id });
        const vm = await api('GetMicrovm', { microvmIdentifier: ref.id });
        if (vm.state !== 'TERMINATED') throw new Error('MicroVM termination not confirmed');
      } catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    },
  };
}
