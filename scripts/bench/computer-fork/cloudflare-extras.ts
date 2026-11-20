// Cloudflare-only checks for native container snapshots (durable_object policy):
//   size   - snapshotContainer time against workspace size (empty, cloned, root installed, all installed)
//   chain  - snapshot a restored fork after it changed (a subagent's own fork), restore that
//   sleep  - destroy without a snapshot and start again: is the disk gone?
//   image  - take a snapshot, then (after you redeploy with a new IMAGE_REV) restore it:
//            --phase before | after --handle <json file>
//
//   node --experimental-strip-types scripts/bench/computer-fork/cloudflare-extras.ts --tokenFile <file> --checks size,chain,sleep
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare, type Machine } from "./providers.ts";
import { check, parse, REPO } from "./workload.ts";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), arg = (k: string, d = "") => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const token = readFileSync(arg("tokenFile"), "utf8").trim();
const p = cloudflare(arg("url", "https://cfork-bench.miguel-85b.workers.dev"), token);
const checks = arg("checks", "size,chain,sleep").split(",");
const tag = `cfx-${Date.now().toString(36).slice(-5)}`;
const out: any = { startedAt: new Date().toISOString(), tag, checks };
const file = join(here, "results", `cloudflare-extras-${checks.join("-")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const save = () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(out, null, 2)); };
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const made: Machine[] = [];
const sh = async (m: Machine, cmd: string, t = 900) => { const r = await p.exec(m, cmd, t); if (r.code) throw new Error(`${cmd.slice(0, 60)}: ${r.stderr.slice(-400)}`); return r.stdout; };
const timed = async <T>(f: () => Promise<T>) => { const t = Date.now(); const v = await f(); return { v, ms: Date.now() - t }; };
const size = async (m: Machine) => Number((await sh(m, "du -skx / 2>/dev/null | cut -f1")).trim());

try {
  if (checks.includes("size") || checks.includes("chain")) {
    const m = await p.create(`${tag}-size`); made.push(m);
    const stages: [string, string][] = [
      ["empty", "true"],
      ["cloned", `mkdir -p /workspace && cd /workspace && git clone -q ${REPO} run`],
      ["root_installed", "cd /workspace/run && npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1"],
      ["all_installed", "cd /workspace/run/backends/workers && npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1"],
    ];
    out.size = [];
    let last: any;
    for (const [name, cmd] of stages) {
      await sh(m, cmd);
      const kb = await size(m);
      const s = await timed(() => p.prepareFork(m, `${tag}-${name}`));
      const again = await timed(() => p.prepareFork(m, `${tag}-${name}-again`));
      out.size.push({ stage: name, rootfsKb: kb, snapshotMs: s.ms, snapshotBytes: (s.v as any).size, unchangedSnapshotMs: again.ms });
      last = s.v; log("size", out.size.at(-1)); save();
    }
    if (checks.includes("chain")) {
      // A subagent forks the parent, changes files, snapshots its own fork, and its own child restores that.
      const f1 = await timed(() => p.fork(last, `${tag}-chain1`)); made.push(f1.v);
      await sh(f1.v, "cd /workspace/run && git checkout -q -b chain && echo chain1 > FORK_ID && dd if=/dev/urandom of=/workspace/blob bs=1M count=200 status=none");
      const s2 = await timed(() => p.prepareFork(f1.v, `${tag}-chain1-snap`));
      const f2 = await timed(() => p.fork(s2.v, `${tag}-chain2`)); made.push(f2.v);
      const first = await timed(() => p.exec(f2.v, "true"));
      out.chain = { restoreMs: f1.ms, snapshotOfForkMs: s2.ms, snapshotOfForkBytes: (s2.v as any).size, restoreOfForkMs: f2.ms, firstCommandAfterMs: first.ms,
        state: parse(await sh(f2.v, check("/workspace"))), blobKb: (await sh(f2.v, "du -sk /workspace/blob | cut -f1")).trim() };
      log("chain", out.chain); save();
    }
  }
  if (checks.includes("sleep")) {
    const m = await p.create(`${tag}-sleep`); made.push(m);
    await sh(m, "mkdir -p /workspace && echo kept > /workspace/marker && echo kept > /root/marker");
    const d = await timed(() => p.destroy(m));
    const s = await timed(() => p.create(m.name));
    out.sleep = { destroyMs: d.ms, restartMs: s.ms, afterRestart: (await sh(m, "cat /workspace/marker /root/marker 2>&1 || true")).trim(), bootId: (await sh(m, "cat /proc/sys/kernel/random/boot_id")).trim() };
    log("sleep", out.sleep); save();
  }
  if (checks.includes("image")) {
    const phase = arg("phase", "before"), hfile = arg("handle", join(here, "results", "cloudflare-image-handle.json"));
    if (phase === "before") {
      const m = await p.create(`${tag}-img`); made.push(m);
      await sh(m, "mkdir -p /workspace && echo from-rev-$(cat /etc/bench-image-rev) > /workspace/marker");
      const s = await p.prepareFork(m, `${tag}-img`);
      writeFileSync(hfile, JSON.stringify({ snapshot: s, rev: (await sh(m, "cat /etc/bench-image-rev")).trim() }));
      out.image = { phase, snapshot: s }; log("image before", out.image);
    } else {
      const h = JSON.parse(readFileSync(hfile, "utf8"));
      const fresh = await p.create(`${tag}-imgnew`); made.push(fresh);
      const newRev = (await sh(fresh, "cat /etc/bench-image-rev")).trim();
      let restored: any;
      try {
        const f = await timed(() => p.fork(h.snapshot, `${tag}-imgold`)); made.push(f.v);
        restored = { ok: true, ms: f.ms, rev: (await sh(f.v, "cat /etc/bench-image-rev")).trim(), marker: (await sh(f.v, "cat /workspace/marker")).trim() };
      } catch (e) { restored = { ok: false, error: (e as Error).message }; }
      out.image = { phase, snapshotRev: h.rev, deployedRev: newRev, restoreOldSnapshot: restored }; log("image after", out.image);
    }
    save();
  }
} catch (e) {
  out.error = String((e as Error).stack ?? e); log("ERROR", e);
} finally {
  for (const m of made) await p.destroy(m).catch(e => (out.cleanupErrors ??= []).push(`${m.name}: ${e.message}`));
  out.destroyed = made.map(m => m.name); out.finishedAt = new Date().toISOString(); save(); log("done ->", file);
}
