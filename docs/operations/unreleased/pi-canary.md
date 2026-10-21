### Task size and memory watch for Pi

Terraform runs 1 vCPU / 4 GiB tasks with the admission threshold
(`AGENT_MEMORY_HIGH_BYTES`) at 65% of them (2.6 GiB) and `node_load` every five
seconds (`AGENT_LOAD_INTERVAL_MS=5000`), which logs Node heap, RSS, voice workers
and the visible cgroup current/high-water memory; the default stays 60 seconds.
The cgroup may include helper processes: do not read it as the Node heap alone.
The `-task-cgroup-memory` deployment alarm (cgroup memory over 3 GiB) replaces the
hand-made `-pi-canary-memory` alarm.
