# Devbox scripts

`loop.sh` runs a soak round on main with `PROP_SCALE=50`, then runs the image check every
`IMAGE_EVERY` cycles (default 1). It uses the installed copies of `ci-run`, `soak-seq.sh` and
`image-check.sh` in `~/camelrun-ci/`. The lock allows only one copy to run.

```crontab
*/10 * * * * $HOME/camelrun-ci/loop.sh >/dev/null 2>&1
@reboot $HOME/camelrun-ci/loop.sh >/dev/null 2>&1
```

Create `~/camelrun-ci/loop/stop` to stop after the current step. Remove the file to let cron
start the loop again. The loop records each cycle in `loop/cycles.tsv`. The soak and image
checks write to `soak/rounds.tsv`, `soak/failures.tsv` and `soak/images.tsv`.

To install a new loop script, copy it beside the running script and rename it into place.
