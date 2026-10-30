### Vendored Pi carries no patches of ours (can be rolled back)

A fork reads its source's context through Pi's own derivation on a read-only viewer Harness again (Pi's recommended
way for a reader), instead of our patch `readStoredContext`. That was the last patch: the vendored packages are now
Pi's own build, `1.4.0-main.f09d01b85e03`. The fork point refusals (before the newest head marker, inside an entry of
several messages) and the compaction kept-range cut are unchanged. No stored format changes.
