# Prototype: a Pierre-style git API we own (Workers + DO + R2)

`DESIGN.md` has the design and the verdict; `RESULTS.md` the numbers.

```sh
npm test                                   # Node server + real git CLI
npx wrangler@4 dev --port 8794 &           # Worker + DO + local R2 (never deployed)
GITAPI_URL=http://127.0.0.1:8794 npm test  # same test against the Worker
npm run node -- ./data 8795 &              # Node server (CPU per request at /_cpu)
GITAPI_URL=http://127.0.0.1:8795 BENCH_SIZES=small,medium,large npm run bench
```

Node 22 and git on PATH; no npm dependencies.
