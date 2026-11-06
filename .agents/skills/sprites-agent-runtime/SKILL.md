---
name: sprites-agent-runtime
description: Run agent-runtime tests, typecheck, builds and any other heavy work on the team's Fly.io Sprites pool instead of the laptop; fan out one job per sprite. For people logged in to the camelai Sprites org (sprite login -o camelai).
---

# agent-runtime on Sprites

`scripts/sprite-test [ref] [command...]` sends the committed tree at a ref to a leased sprite and runs a command there.
The laptop keeps reading, editing and the loop you are driving; suites, typecheck, builds and anything over about 30
seconds go here.

```sh
scripts/sprite-test                                     # the full suite at HEAD: 8 shards on 8 sprites, 8-10 minutes
scripts/sprite-test origin/main                          # the full suite at a ref
scripts/sprite-test HEAD npm run typecheck               # any command, in the checkout at that commit
scripts/sprite-test HEAD npm run build                   # build, build:console, openapi, docs, test:ui, test:python
scripts/sprite-test HEAD node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/api.test.ts
scripts/sprite-test HEAD bash -lc 'npm run -s typecheck && npm run -s openapi'   # a stage of several commands
scripts/sprite-test --dirty HEAD npm run build           # the working tree, uncommitted (untracked included)
scripts/sprite-test --status                             # who holds which sprite, and the commit each has
scripts/sprite-test --stats                              # leases, their ages, the commits the pool holds
scripts/sprite-test --grow 4                             # create and warm four more pool sprites
scripts/sprite-test --reap 30                            # sprites nothing has used in 30 days; deletes nothing
scripts/sprite-test --warm                               # prepare every free sprite at HEAD
```

A run gets the tree from `git archive` (never the working directory: `.env` and ignored files stay on the laptop), then
Node 22 (as CI), a fresh Postgres 16 container with CI's flags (tmpfs, `fsync` off, 1000 connections), `npm ci` when
`package-lock.json` or Node changed, and a v8-exec rebuild when `sandbox/v8-exec` changed. `--dirty` sends the working
tree as a temporary commit: staged, unstaged and untracked files (what `.gitignore` keeps out stays out), without
touching your index, and never secrets (`.env*`, `.dev.vars*`, keys, `*.tfvars`, credentials files: it lists what it
kept back). `SPRITE_SHARDS` sets the shards (default 8), `SPRITE_NAME` pins sprites, `SPRITE_POOL` the pool size
(default 42); `scripts/sprite-test --help` lists the rest.

`scripts/sprite-test` is only this repo's configuration: the machinery is the shared core in the sprites skill
(`~/.agents/skills/sprites/scripts/sprite-test-core.sh`), which camel-bots runs too. Change the machinery there, for both
repos; if this repo starts relying on a new core feature, name it in `sprite_requires`, so an older core stops with a
clear error (`scripts/sprite-test --check-core`, and `tests/sprite-test.test.ts` where a core is installed).

Every pool sprite also has Docker with Buildx (set up once per sprite by the core), so the Workers
backend's native container tests run there as on CI, `WORKERS_REQUIRE_DOCKER=1` included:
`scripts/sprite-test --shards=3 HEAD bash backends/workers/scripts/validate-sprite.sh integration '{shard}/{shards}'`.
It differs from a stock host in three ways, all because a sprite's root has no `CAP_SYS_PTRACE` and its kernel no
`xt_socket`: runc 1.1.15 instead of Ubuntu's 1.4 (1.2+ cannot start a container in another's network namespace; crun
hangs bridge containers), a runc wrapper whose `start` waits for the container's process (an exec before then fails),
and the Workers test's egress sidecar without its `-m socket` rule. Bridge networking, `-p`/`-P` and `docker build` work;
a bridge container whose image starts as non-root does not start, and `docker exec` into a container whose process is
not root fails. Details: `backends/workers/README.md`, "Docker on a sprite".

Fan out by starting several and waiting — each leases its own sprite:

```sh
scripts/sprite-test HEAD npm run typecheck &
scripts/sprite-test HEAD npm run build &
scripts/sprite-test HEAD node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/api.test.ts &
wait
```

The pool grows when the work does: a sleeping sprite costs nothing, and a run creates the next `rt-pool-N` itself when
every existing one is busy. To add one ahead of time, `sprite create -o camelai --skip-console rt-pool-41` then
`SPRITE_NAME=rt-pool-41 scripts/sprite-test --warm` (a new sprite sets itself up once: packages, Postgres, v8-exec).

**Never mount a sprite's filesystem.** Measured on this pool: sshfs costs one round trip per file (22.9 ms for a 1 KB
read), so `grep -r` over 300 files takes 8.2 s against 0.004 s natively, and `compileall` 51 s against 0.4 s; worse, when
the tunnel dies an sshfs mount returns **empty listings and `ENOENT` for files that exist**, and a write reports success
and vanishes. Copy the tree and run the work natively, which is what this script does: rsync over `sprite proxy --ssh`
(no sshd, no keys, no macFUSE), a tar stream if rsync fails. `--fetch` brings results back the same way, about 8 MB/s;
`sprite file push`/`pull` is for one hot file only, at about 60 ms a file (1,500 files: 94 s against rsync's 3.8 s), and
needs a real rsync 3.x (macOS's `openrsync` fails with "unexpected end of file"). `sprite info`'s `Status` is noisy and
partly self-fulfilling; a real `exec` is the readiness probe.

Leases, waiting, exit codes (75 no sprite free, 69 contact lost, 137 killed) and the sync/retry machinery: the header of
`scripts/sprite-test`; the cross-repo rules are `~/.agents/skills/sprites/SKILL.md`. A shard's failures in at most 3
files are rerun alone, and a file that passes then is flaky: fix it, don't rerun until green.
