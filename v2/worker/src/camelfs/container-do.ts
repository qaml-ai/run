import { DurableObject } from "cloudflare:workers";
import { ApiError, type Env } from "../types.ts";

/**
 * CamelfsContainerDO wraps a single Cloudflare Container (`ctx.container`)
 * running `camelfs-cf-containerd` on port 8080 under `scheduling_policy: "durable_object"`.
 *
 * Inside Cloudflare Containers (Linux 6.18+, uid=0, CAP_SYS_ADMIN, /dev/fuse, tmpfs, overlayfs),
 * `camelfs-cf-containerd` mounts a Read-Only Lazy FUSE lowerdir over HTTP blobs + RAM tmpfs
 * upperdir + native kernel overlayfs (`rofuse_kernel_overlay_tmpfs`), matching EC2 Firecracker
 * write performance with zero FUSE write syscalls.
 */
export class CamelfsContainerDO extends DurableObject<Env> {
  private readonly port = 8080;

  private async ensureStarted(opts?: { enableInternet?: boolean }): Promise<{
    container: Container;
    coldStarted: boolean;
    bootMs: number;
    execReadyMs: number;
  }> {
    const container = this.ctx.container;
    if (!container) {
      throw new ApiError(500, "container_unavailable", "ctx.container is not bound on CamelfsContainerDO");
    }
    const t0 = Date.now();
    if (!container.running) {
      const images = (container as unknown as { images?: Record<string, string> }).images;
      const imageRef = images?.camelfs ?? (images ? Object.values(images)[0] : undefined);
      const startOpts: Record<string, unknown> = {
        enableInternet: opts?.enableInternet ?? true,
      };
      if (imageRef) {
        startOpts.image = imageRef;
      }
      const instanceType = this.env.CAMELFS_CONTAINER_INSTANCE || "standard-1";
      startOpts.instance = instanceType;
      container.start(startOpts as Parameters<Container["start"]>[0]);

      const containerWithExtras = container as unknown as {
        monitor?: () => Promise<void>;
        exec?: (
          argv: string[],
          opts?: { signal?: AbortSignal; stdout?: string; stderr?: string },
        ) => Promise<{ exitCode: Promise<number> }>;
      };

      const watch = containerWithExtras.monitor?.().then(
        () => {
          throw new ApiError(502, "container_exited", "Cloudflare container exited during startup");
        },
        (err: unknown) => {
          throw new ApiError(
            502,
            "container_start_failed",
            `Cloudflare container failed to start: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
      watch?.catch(() => {});

      let execReadyMs = 0;
      if (containerWithExtras.exec) {
        const readyExec = (async () => {
          const proc = await containerWithExtras.exec!(["true"], {
            signal: AbortSignal.timeout(30_000),
            stdout: "ignore",
            stderr: "ignore",
          });
          const rc = await proc.exitCode;
          if (rc !== 0) {
            throw new ApiError(502, "container_exec_failed", `Container startup probe exited with ${rc}`);
          }
        })();
        await (watch ? Promise.race([readyExec, watch]) : readyExec);
        execReadyMs = Date.now() - t0;
      }

      const tcp = container.getTcpPort(this.port);
      const deadline = Date.now() + 15_000;
      let lastErr = "";
      while (Date.now() < deadline) {
        try {
          const res = await tcp.fetch("http://container/healthz", {
            signal: AbortSignal.timeout(2_000),
          });
          if (res.ok) {
            await res.body?.cancel().catch(() => {});
            return { container, coldStarted: true, bootMs: Date.now() - t0, execReadyMs };
          }
          lastErr = `HTTP ${res.status}`;
          await res.body?.cancel().catch(() => {});
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new ApiError(
        504,
        "container_port_timeout",
        `camelfs-cf-containerd port 8080 not ready after execReady=${execReadyMs}ms: ${lastErr}`,
      );
    }
    return { container, coldStarted: false, bootMs: 0, execReadyMs: 0 };
  }

  async proxy(
    path: string,
    method: string,
    body?: string,
  ): Promise<{
    status: number;
    text: string;
    coldStarted: boolean;
    bootMs: number;
    execReadyMs: number;
  }> {
    const { container, coldStarted, bootMs, execReadyMs } = await this.ensureStarted({
      enableInternet: true,
    });
    const tcp = container.getTcpPort(this.port);
    const res = await tcp.fetch(`http://container${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body,
      signal: AbortSignal.timeout(90_000),
    });
    return { status: res.status, text: await res.text(), coldStarted, bootMs, execReadyMs };
  }

  async destroyContainer(): Promise<void> {
    if (this.ctx.container?.running) {
      await this.ctx.container.destroy();
    }
  }
}

export async function callContainerDaemon<T>(
  env: Env,
  vmId: string,
  path: string,
  method: "GET" | "POST" = "POST",
  payload?: unknown,
): Promise<T> {
  const bodyStr = payload !== undefined ? JSON.stringify(payload) : undefined;
  let status: number;
  let text: string;

  if (env.CAMELFS_CONTAINER_URL) {
    const base = env.CAMELFS_CONTAINER_URL.replace(/\/+$/, "");
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(bodyStr !== undefined ? { "Content-Type": "application/json" } : {}),
        "X-Camel-Vm-Id": vmId,
      },
      body: bodyStr,
    });
    status = res.status;
    text = await res.text();
  } else if (env.CAMELFS_CONTAINER_DO) {
    const stub = env.CAMELFS_CONTAINER_DO.get(env.CAMELFS_CONTAINER_DO.idFromName(vmId));
    const res = await (stub as unknown as CamelfsContainerDO).proxy(path, method, bodyStr);
    status = res.status;
    text = res.text;
  } else {
    throw new ApiError(
      503,
      "compute_not_configured",
      "Neither CAMELFS_CONTAINER_URL nor CAMELFS_CONTAINER_DO binding is configured",
    );
  }

  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (status < 200 || status >= 300) {
    const errObj =
      parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error?: { code?: string; message?: string } }).error
        : undefined;
    throw new ApiError(
      status,
      errObj?.code ?? `container_${status}`,
      errObj?.message ?? (text || `camelfs-cf-containerd HTTP ${status}`),
    );
  }

  return parsed as T;
}

export async function destroyContainerInstance(env: Env, vmId: string): Promise<void> {
  if (env.CAMELFS_CONTAINER_DO && !env.CAMELFS_CONTAINER_URL) {
    const stub = env.CAMELFS_CONTAINER_DO.get(env.CAMELFS_CONTAINER_DO.idFromName(vmId));
    await (stub as unknown as CamelfsContainerDO).destroyContainer();
  }
}
