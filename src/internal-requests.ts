import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { network } from "./node-context.ts";
import { HttpError, errorStatus, readText } from "./http.ts";
import { errorText } from "./protocol.ts";
import { VersionConflict, type VolumeService } from "./volumes.ts";

export function internalRequests(secret: string) {
  /** Node-to-node requests are signed with the session secret all nodes share. */
  const signature = (timestamp: string, path: string, body: string) =>
    createHmac("sha256", secret).update(`internal:${timestamp}:${path}:${createHash("sha256").update(body).digest("hex")}`).digest("hex");

  function signedPost(owner: string, path: string, payload: unknown, timeoutMs = 15_000, signal?: AbortSignal) {
    const body = JSON.stringify(payload);
    const timestamp = String(Date.now());
    return network().fetch(new URL(path, owner), {
      method: "POST", body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", "x-agent-runtime-internal": `${timestamp}.${signature(timestamp, path, body)}` },
    });
  }

  /** Read a node-to-node request's body, or undefined when its signature is missing, stale or wrong. */
  async function signedBody(c: Context): Promise<string | undefined> {
    const body = await readText(c.req.raw.body, 1_100_000);
    const [timestamp, checksum] = (c.req.header("x-agent-runtime-internal") ?? "").split(".");
    const expected = Buffer.from(signature(timestamp ?? "", c.req.path, body));
    const given = Buffer.from(checksum ?? "");
    if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 60_000 || expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    return body;
  }

  // Volume operations on another node keep their status (and a conflict's current version).
  const volumePeer = async (owner: string, path: string, payload: unknown) => {
    const response = await signedPost(owner, path, payload, 30_000);
    const value = await response.json().catch(() => ({})) as any;
    if (response.ok) return value;
    throw Object.assign(new HttpError(response.status, value.error ?? `Volume owner answered HTTP ${response.status}`), value.current !== undefined ? { current: value.current } : {});
  };

  function mountVolumeOperations(app: { post(path: string, handler: (c: Context) => Promise<Response>): unknown }, volumes: VolumeService) {
    app.post("/internal/volumes/:id{vol_[a-f0-9]{24}}/ops", async c => {
      let body: string | undefined;
      try { body = await signedBody(c); } catch { return c.body(null, 413); }
      if (body === undefined) return c.body(null, 401);
      try {
        const { tenant, op, args } = JSON.parse(body);
        return c.json(await volumes.handle(c.req.param("id")!, tenant, op, args));
      } catch (error) {
        return c.json({ error: errorText(error), ...(error instanceof VersionConflict ? { current: error.current } : {}) }, errorStatus(error, 400) as ContentfulStatusCode);
      }
    });
  }

  return { signature, signedPost, signedBody, volumePeer, mountVolumeOperations };
}
