### A computer command past its timeout answers `timedOut` with its output

On the Workers backend, a `computer` exec that runs past its `timeoutMs` (30 seconds by default, at most 600 seconds) is still killed. Its result now carries `timedOut: true` along with the stdout and stderr it wrote before the kill, bounded as always. Before, it came back as an empty exit 137, which looked like a crash.

The tool's description now gives the 30-second default.
