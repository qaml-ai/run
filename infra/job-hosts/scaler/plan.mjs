// The job-host scaler's decisions (docs/design/job-hosts-plan.md, slice 8), apart from AWS so they can be tested: from
// the runtime's per-pool demand (GET /v1/internal/job-hosts/demand: jobs/hosts.ts JobHostRegistry.demand) and the
// pools' Auto Scaling groups, what to do this minute.
// - Scale out: jobs are waiting and the pool's capacity (its live hosts' slots, plus hosts still booting) is less
//   than what is running and waiting: raise the group's desired count by the hosts that make up the difference, up to
//   its maximum.
// - Scale in: nothing waits, and a host has been idle (every slot free) for IDLE_MINUTES: drain it (the runtime places
//   nothing more on it), and the next minute, if it is still idle, terminate it, lowering the desired count, never
//   below the group's minimum.
// - Termination hooks: a host the group is terminating (scale-in, health, rebalance) is drained, and its hook is
//   completed once it runs nothing and was already draining when read (the minute after its drain, so no job placed in
//   between is cut off), or once it has been gone ABSENT_MS (a reconnect of a few seconds is not "gone"). The hook's
//   own timeout is the backstop.
// - Drains are never one-way: while jobs wait, a draining host still in service is undrained and counted again, rather
//   than idling beside a new host booting.
// Every decision is from this minute's view alone; a call that fails is made again next minute.

/**
 * @param {{ pools: Record<string, { hosts: { host: string; slots: number; running: number; draining: boolean; idleSince: number | null }[]; running: number; waiting: number }> }} demand
 * @param {Record<string, { name: string; min: number; max: number; desired: number; instances: { id: string; state: string }[]; slots: number } | undefined>} groups
 * @param {{ now: number; idleMs: number }} options
 */
/** How long a terminating host must have been gone (no heartbeat) before its hook is completed without it. */
export const ABSENT_MS = 5 * 60_000;

export function plan(demand, groups, { now, idleMs }) {
  const actions = [];
  for (const [pool, group] of Object.entries(groups)) {
    if (!group) continue;
    const need = demand.pools?.[pool] ?? { hosts: [], gone: [], running: 0, waiting: 0 };
    const live = new Map(need.hosts.map(host => [host.host, host]));
    const gone = new Map((need.gone ?? []).map(host => [host.host, host]));
    const inGroup = new Set(group.instances.map(instance => instance.id));

    // Termination hooks: drain what the group is ending; complete the hook once nothing runs there.
    for (const instance of group.instances.filter(instance => instance.state === "Terminating:Wait")) {
      const host = live.get(instance.id);
      if (host) {
        if (!host.draining) actions.push({ type: "drain", pool, host: instance.id });
        else if (host.running === 0) actions.push({ type: "complete", pool, group: group.name, instance: instance.id });
      } else {
        // Not live: complete once it has been gone ABSENT_MS, or if the runtime has never heard of it (it never enrolled).
        const last = gone.get(instance.id)?.lastSeenAt;
        if (last === undefined || now - last >= ABSENT_MS) actions.push({ type: "complete", pool, group: group.name, instance: instance.id });
      }
    }
    // Jobs wait: a draining host still in service takes jobs again (counted below as not draining).
    const inService = new Set(group.instances.filter(instance => instance.state === "InService").map(instance => instance.id));
    if (need.waiting > 0) for (const host of need.hosts) if (host.draining && inService.has(host.host)) {
      actions.push({ type: "undrain", pool, host: host.host });
      host.draining = false;
    }

    // Hosts the group counts toward its capacity: in service or still booting.
    const counted = group.instances.filter(instance => instance.state === "InService" || instance.state.startsWith("Pending"));
    const booting = counted.filter(instance => !live.has(instance.id)).length;
    const capacity = need.hosts.filter(host => inGroup.has(host.host) && !host.draining).reduce((sum, host) => sum + host.slots, 0) + booting * group.slots;
    const wanted = need.running + need.waiting;

    if (need.waiting > 0 && wanted > capacity) {
      const desired = Math.min(group.max, Math.max(group.desired, counted.length + Math.ceil((wanted - capacity) / group.slots)));
      if (desired > group.desired) actions.push({ type: "desired", pool, group: group.name, desired, from: group.desired });
      continue;
    }

    if (need.waiting === 0) {
      let left = counted.length;
      const idle = need.hosts
        .filter(host => inGroup.has(host.host) && host.running === 0 && host.idleSince !== null && now - host.idleSince >= idleMs)
        .filter(host => group.instances.find(instance => instance.id === host.host)?.state === "InService")
        .sort((a, b) => a.idleSince - b.idleSince);
      // Drained one minute, ended the next if it is still idle: a job placed between this minute's read and its drain
      // shows up as running, and the host is ended only once it has finished.
      for (const host of idle) {
        if (left <= group.min) break;
        actions.push(host.draining ? { type: "terminate", pool, group: group.name, instance: host.host } : { type: "drain", pool, host: host.host });
        left--;
      }
    }
  }
  return actions;
}
