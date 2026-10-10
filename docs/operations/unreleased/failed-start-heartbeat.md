### A node that fails to start leaves the cluster

- A node joins the cluster (its heartbeat) before it listens. One whose port was taken, or that refused to run
  `AGENT_STORAGE=file` beside another node, used to exit with its heartbeat still live: peers counted it as a live
  peer (a retiring task could take it for its replacement, a draining one route work to it) until they found it dead,
  or for its whole lease when whatever held the port accepted their probes. It now leaves first, as a draining node
  does, so peers never see it.
