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
//   completed once the host runs nothing or has gone (disconnected), so a terminating host never cuts off a job and
//   never waits out the full hook for nothing.
// Every decision is from this minute's view alone; a call that fails is made again next minute.

/**
 * @param {{ pools: Record<string, { hosts: { host: string; slots: number; running: number; draining: boolean; idleSince: number | null }[]; running: number; waiting: number }> }} demand
 * @param {Record<string, { name: string; min: number; max: number; desired: number; instances: { id: string; state: string }[]; slots: number } | undefined>} groups
 * @param {{ now: number; idleMs: number }} options
 */
export function plan(demand, groups, { now, idleMs }) {
  const actions = [];
  for (const [pool, group] of Object.entries(groups)) {
    if (!group) continue;
    const need = demand.pools?.[pool] ?? { hosts: [], running: 0, waiting: 0 };
    const live = new Map(need.hosts.map(host => [host.host, host]));
    const inGroup = new Set(group.instances.map(instance => instance.id));

    // Termination hooks: drain what the group is ending; complete the hook once nothing runs there.
    for (const instance of group.instances.filter(instance => instance.state === "Terminating:Wait")) {
      const host = live.get(instance.id);
      if (host && !host.draining) actions.push({ type: "drain", pool, host: instance.id });
      if (!host || host.running === 0) actions.push({ type: "complete", pool, group: group.name, instance: instance.id });
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
