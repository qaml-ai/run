// The isolation suite (docs/design/job-hosts-plan.md, slice 6): what a job VM must not reach, checked from inside real
// VMs on a real host rather than assumed. It boots VMs through the host's own launcher and runs probes as jobs would:
// - IMDS is unreachable, directly and through the proxy;
// - the host answers nothing but the proxy, and the VPC and other private ranges are unreachable;
// - one job cannot reach another's VM;
// - with internet, an allowlisted host is reachable through the proxy and others are refused; without it, nothing is;
// - the pid cap holds, and a full disk shows up as too little free space (the agent's disk_low).
// Run it on a host built from infra/job-hosts/image, after the go-ahead:
//   sudo node --experimental-strip-types jobhost/isolation-suite.ts        (exits 1 if any check fails)
import { firecrackerLauncher } from "./firecracker.ts";
import { jobAddress } from "./network.ts";
import type { Vm, VmLauncher } from "./vm.ts";
import { lookup } from "node:dns/promises";

export type Check = { name: string; ok: boolean; detail: string };
// At least the base image (6 GiB): a job disk is the base grown by truncate + resize2fs, never shrunk.
const SHAPE = { vcpus: 1, memoryMiB: 1024, diskMiB: 8192 };

type Ran = { exitCode: number | null; stdout: string; stderr: string };
async function sh(vm: Vm, command: string, extra: Record<string, unknown> = {}): Promise<Ran> {
  const reply = await vm.request({ op: "run", command, timeoutSeconds: 30, ...extra });
  if (!reply.ok) throw new Error(String(reply.error ?? "run failed"));
  const text = (stream: unknown) => Buffer.from(String((stream as { data?: string })?.data ?? ""), "base64").toString("utf8");
  return { exitCode: reply.exitCode as number | null, stdout: text(reply.stdout), stderr: text(reply.stderr) };
}
/** A TCP connection from the guest: 0 when it opened, non-zero when refused, dropped or timed out. */
const tcp = (host: string, port: number) => `timeout 4 bash -c 'exec 3<>/dev/tcp/${host}/${port}' 2>/dev/null`;
/** An HTTPS fetch through the job's proxy (the guest's init exports https_proxy when the job has internet). */
const fetchVia = (url: string) => `curl -sS -o /dev/null -m 15 -w '%{http_code}' '${url}'`;

export async function isolationSuite(launcher: VmLauncher, options: { allowed?: string; refused?: string } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const check = async (name: string, run: () => Promise<{ ok: boolean; detail: string }>) => {
    try { checks.push({ name, ...await run() }); } catch (error) { checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  };
  const allowedUrl = options.allowed ?? "https://registry.npmjs.org/", refusedUrl = options.refused ?? "https://example.com/";
  const online = await launcher.boot("isolation-online", SHAPE, { internet: true });
  const offline = await launcher.boot("isolation-offline", SHAPE, { internet: false });
  try {
    // The guests' own addresses, as their inits set them (network.ts: one slot each).
    const own = async (vm: Vm) => (await sh(vm, "ip -4 -o addr show dev eth0 | awk '{print $4}' | cut -d/ -f1")).stdout.trim();
    const onlineIp = await own(online), offlineIp = await own(offline);
    const gateway = onlineIp.replace(/\.2$/, ".1");
    const refusedAll = (ran: Ran) => ({ ok: ran.exitCode !== 0, detail: `exit ${ran.exitCode}` });

    await check("IMDS is unreachable directly", async () => refusedAll(await sh(online, tcp("169.254.169.254", 80))));
    await check("IMDS is unreachable through the proxy", async () => {
      const ran = await sh(online, fetchVia("https://169.254.169.254/latest/meta-data/"));
      return { ok: ran.exitCode !== 0 || ran.stdout !== "200", detail: `exit ${ran.exitCode}, ${ran.stdout}` };
    });
    for (const port of [22, 80, 443, 8080]) await check(`the host answers nothing on ${port}`, async () => refusedAll(await sh(online, tcp(gateway, port))));
    await check("Amazon's DNS is unreachable from a guest", async () => refusedAll(await sh(online, tcp("169.254.169.253", 53))));
    await check("the VPC is unreachable", async () => refusedAll(await sh(online, tcp("10.0.0.2", 53))));
    await check("another job's VM is unreachable", async () => refusedAll(await sh(online, tcp(offlineIp, 22))));
    await check("another job's tap is unreachable", async () => refusedAll(await sh(online, tcp(offlineIp.replace(/\.2$/, ".1"), 3128))));
    await check("passing for another job's address gets nothing", async () => {
      // The guest takes the other slot's address and asks the proxy as that job: the host drops a source that does
      // not route back through the tap it came in on.
      const other = jobAddress(250 - 1).guestIp;
      return refusedAll(await sh(online, `ip addr add ${other}/32 dev eth0 && curl -sS -m 5 --interface ${other} -o /dev/null -x http://${gateway}:3128 https://registry.npmjs.org/`));
    });
    await check("an allowlisted host is reachable through the proxy", async () => {
      const ran = await sh(online, fetchVia(allowedUrl));
      return { ok: ran.exitCode === 0 && /^[23]\d\d$/.test(ran.stdout), detail: `exit ${ran.exitCode}, ${ran.stdout}` };
    });
    await check("a host off the allowlist is refused", async () => refusedAll(await sh(online, fetchVia(refusedUrl))));
    // Plain HTTP goes to the proxy (init exports http_proxy too), which answers 403 to anything but CONNECT: curl exits 0
    // on a 403, so the status is what shows the refusal. Without the proxy, port 80 must not connect at all, even to an address.
    await check("port 80 is refused even to an allowlisted host", async () => {
      const proxied = await sh(online, `curl -sS -o /dev/null -m 10 -w '%{http_code}' http://registry.npmjs.org/`);
      // A literal address, resolved here on the host: the guest has no DNS, so a name fails at resolution (curl exit 6)
      // and proves nothing about the path. Only a refused (7) or timed-out (28) connect shows port 80 is closed.
      const { address } = await lookup("registry.npmjs.org", { family: 4 });
      const direct = await sh(online, `curl -sS -o /dev/null -m 10 --noproxy '*' -H 'Host: registry.npmjs.org' http://${address}/`);
      return { ok: proxied.stdout.trim() === "403" && (direct.exitCode === 7 || direct.exitCode === 28), detail: `proxied ${proxied.stdout.trim() || `exit ${proxied.exitCode}`}, direct to ${address} exit ${direct.exitCode}` };
    });
    await check("a job without internet reaches nothing, not even the allowlist", async () =>
      refusedAll(await sh(offline, `curl -sS -o /dev/null -m 10 -x http://${offlineIp.replace(/\.2$/, ".1")}:3128 ${allowedUrl}`)));
    await check("the pid cap holds", async () => {
      const ran = await sh(online, `for i in $(seq 300); do sleep 20 & done 2>&1; wait`, { pids: 64, timeoutSeconds: 40 });
      return { ok: /Resource temporarily unavailable|fork/i.test(ran.stdout + ran.stderr), detail: `exit ${ran.exitCode}` };
    });
    await check("a full disk shows as too little free space", async () => {
      await sh(online, `fallocate -l "$(( $(df --output=avail -B1 / | tail -1) - 4096 ))" /fill || dd if=/dev/zero of=/fill bs=1M 2>/dev/null; true`);
      const free = await online.request({ op: "free" });
      return { ok: free.ok && Number(free.freeBytes) < 64 * 1024 * 1024, detail: `free ${free.freeBytes}` };
    });
  } finally {
    await Promise.all([online.destroy(), offline.destroy()]);
  }
  return checks;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const launcher = firecrackerLauncher({
    firecracker: "/usr/local/bin/firecracker", kernel: "/var/lib/camel/guest/vmlinux", initrd: "/var/lib/camel/guest/initrd.img",
    image: "/var/lib/camel/nvme/base.ext4", work: "/var/lib/camel/nvme/jobs", policyDir: "/run/camel/egress",
  });
  const checks = await isolationSuite(launcher);
  for (const item of checks) console.log(`${item.ok ? "ok  " : "FAIL"}  ${item.name}  (${item.detail})`);
  process.exit(checks.every(item => item.ok) ? 0 : 1);
}
