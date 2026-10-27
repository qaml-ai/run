### jemalloc for the runtime's node process

The image preloads jemalloc (`LD_PRELOAD`) for the runtime's node process. With glibc, memory a voice media worker
thread allocated stays reserved in that thread's arena after the worker is ended, so the node's RSS steps up with each
worker kill: measured, 32 kills left a node at 713 MB against 80 MB before them; with jemalloc, 144 MB against 100 MB.
Baseline RSS is about 20 MB higher. Confined processes (v8-exec, file parsing) and agent processes do not get
`LD_PRELOAD`: the launcher gives the former an empty environment and `agentProcessEnv` does not pass it. The build fails
if jemalloc does not load. To turn it off without a rebuild, set `LD_PRELOAD` to empty in the task definition.
