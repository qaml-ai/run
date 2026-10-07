# Devbox scripts

The nightly simulator run on the CI devbox (`camel-devbox`). It runs beside `ci-run` and `soak-seq.sh` in
`~/camelrun-ci/`, and is kept here so changes to it get reviewed.

- `sim-nightly.sh [from] [to] [ref]` runs the deterministic simulator (`npm run sim`) over seeds `from..to` (default
  1..5000) at `ref` (default `origin/main`), in a `ci-run` checkout.
  - It waits until no other `ci-run` is running, so it never competes with a timing-sensitive suite. It checks with
    `pgrep -x` and a parse of each process's arguments, never a pattern over whole command lines, so it never matches
    itself.
  - It holds `~/camelrun-ci/sim/lock` (flock), so two runs never overlap.
  - It writes one line per run to `~/camelrun-ci/sim/nights.tsv`.
  - It exits 1 if any seed failed.
  - Environment: `SIM_SHARDS` sets the number of processes (default 4). `SIM_NOWAIT=1` skips the wait, for a short
    manual run.
- `sim-shards.sh <from> <to> <shards> <outdir>` runs inside the checkout.
  - It splits the seeds over `<shards>` processes.
  - When `SIM_POSTGRES_SEEDS` is set (a count) in its environment and the checkout's simulator has `--postgres`, it then
    runs that many seeds on ci-run's own Postgres. This pass has not run on the devbox yet.
  - It copies every failing seed's plan to `<outdir>` (`~/camelrun-ci/sim-failures/<stamp>/`), then minimizes it
    there (`<seed>.min.json`). Postgres failures go to `<outdir>/postgres/` and are not minimized, because those runs
    are not deterministic.

To look into a failure:

```sh
npm run sim -- --replay <seed>.min.json
npm run sim -- --minimize <seed>.json
```

## Installing

The scripts run from `~/camelrun-ci/`. A nightly may be running from them, and bash reads a script as it runs, so
never overwrite one in place. Copy the new version beside the old one, then rename it over the old one:

```sh
for f in sim-nightly.sh sim-shards.sh; do
  scp scripts/devbox/$f camel-devbox:camelrun-ci/$f.new
  ssh camel-devbox "chmod +x ~/camelrun-ci/$f.new && mv ~/camelrun-ci/$f.new ~/camelrun-ci/$f"
done
```

Run it at low priority beside the soak, for example:

```sh
SIM_SHARDS=6 nice -n 19 ~/camelrun-ci/sim-nightly.sh 1 5000
```

## Around the clock (loop.sh)

`loop.sh` keeps the devbox testing main, one job at a time: a soak round (`soak-seq.sh`, property tests at
PROP_SCALE=50 and the full suite), then a simulator batch of 5000 fresh seeds plus 100 against real Postgres
(`sim-nightly.sh`, continuing from `loop/next-seed`), and every third cycle the image check (`image-check.sh` in a
`ci-run` checkout). cron starts it every 10 minutes and at boot; it holds `loop/lock`, so a second start is a no-op.

    */10 * * * * $HOME/camelrun-ci/loop.sh >/dev/null 2>&1
    @reboot $HOME/camelrun-ci/loop.sh >/dev/null 2>&1

Stop it: `touch ~/camelrun-ci/loop/stop` (it ends after the step in progress; remove the file to let cron start it
again). One line per cycle in `loop/cycles.tsv`; results in `soak/rounds.tsv`, `soak/failures.tsv`, `sim/nights.tsv`,
`sim-failures/<stamp>/` and `soak/images.tsv`. `ci-run`, `soak-seq.sh` and `image-check.sh` are the copies installed
in `~/camelrun-ci`. Never wait on a job with `pgrep -f` and a pattern: it matches the waiting process itself.
