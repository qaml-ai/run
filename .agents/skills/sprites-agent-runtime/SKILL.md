---
name: sprites-agent-runtime
description: Run agent-runtime tests on the team's Fly.io Sprites pool instead of the laptop. For people logged in to the camelai Sprites org. Use when running test files or the full suite off the machine.
---

# agent-runtime on Sprites

Needs the `sprite` CLI logged in to the `camelai` org (`sprite login -o camelai`). Anyone without it runs tests as
[AGENTS.md](../../../AGENTS.md#build-and-test) says. With your work committed:

```sh
scripts/sprite-test                   # the full suite at HEAD as 5 shards on 5 sprites; run it in the background
scripts/sprite-test origin/fix/x      # the full suite at a ref
scripts/sprite-test HEAD node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/<file>.test.ts
scripts/sprite-test --warm            # sync every free sprite to HEAD, so the next runs start at once
scripts/sprite-test --status          # who holds which sprite, and the commit each one has
```

The pool is `rt-pool-1..10`. Each sprite keeps Postgres (durability off, as CI), node_modules and the v8-exec build
between runs; a sleeping sprite costs nothing. A run leases its sprites through the `rt-coordinator` sprite, sends only
the committed tree at the ref (never `.env` or ignored files) with rsync, skipped when the sprite already has the commit,
and runs the command detached while the script polls its log. A full suite takes 8 to 10 minutes; a single file about
20 seconds plus the test. How it works, the settings and the exit codes: the header of `scripts/sprite-test`.

Sprites restarts a sprite now and then; a shard whose job died that way runs again once on the same sprite, so that run
takes longer. Every busy sprite makes a run wait (up to 30 minutes, `SPRITE_WAIT_MINUTES`); exit 75 if none frees.
A shard's failures in at most 3 files are rerun alone (`scripts/test-shard.ts`); one that passes then is reported as
flaky, to be fixed.
