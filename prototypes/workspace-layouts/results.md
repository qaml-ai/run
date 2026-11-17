# Four FUSE-free workspace prototypes

The hybrid preserved direct Git writes and fetched little data before the first read on a new host. It kept Git authoritative, attached a read-only ext4 image of a previous commit, verified requested blocks with dm-verity and applied just the paths that differed from that commit into a Linux OverlayFS upper. This eliminates exact-image production after an ordinary API edit when a suitable base already exists.

## Measurements

Medians of completed trials with 500 MiB of deterministic data, 8,000 data files, a C source file and 128 headers. API time is the stopped-workspace mutation through ref publication. First read is timed from the host before setup through verification in the guest. The guest-only column starts after Linux boot, module loading and the control-share mount. The scan hashes every regular file after a separate compile. The owner’s host checkout preparation precedes the guest-only timer.

| Design | Complete trials | Initial seed | API edit | First read, host | First read, guest | Compile | Scan |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Disk snapshots | 1 | 6.60 s | 7.45 s | 7.25 s | 0.14 s | 0.15 s | 18.06 s |
| Full Git archive | 2 | 21.29 s | 0.035 s | 50.22 s | 39.49 s | 0.11 s | 10.74 s |
| Host checkout | 1 | 25.94 s | 0.036 s | 8.06 s | 0.12 s | 0.41 s | 33.07 s |
| Git plus lazy ext4 | 1 | 32.67 s | 0.038 s | 9.62 s | 0.38 s | 0.29 s | 27.75 s |

At 64 MiB all four modes completed two measured lifecycles. Their median guest times to first read were 0.135 s for block snapshots, 5.005 s for the full Git archive, 0.085 s for the host checkout and 0.440 s for Git plus lazy ext4. These times include workspace mounting. Each trial used fresh nested QEMU processes, a local bare Git repository or local HTTP range origin, and local SQLite refs. The guest ramdisk, tar transport, software CPU, fixture and origin differ from the pilot. The archive extracts to tmpfs and therefore has an advantage on the scan after paying for the initial copy. No physical host cache flush was attempted. Treat timing differences across Sprites and small sample counts accordingly.

At 500 MiB the hybrid transferred 3,641,856 bytes of image ranges and 10,437 bytes of file/descriptor data up to first read. It served 552,018,432 image bytes by completion of the edit session. The disk arm needed 2,556,016 range bytes before first read and published a 5 MiB qcow2 checkpoint layer. The Git arm delivered 528,547,840 archive bytes before first read. The owner exported its native files via kernel 9p; its file traffic is unmetered. It spent 0.44 s preparing a warm checkout and 1.55 s reconstructing the checkout from the local Git store on recovery.

The base costs real work. The 500 MiB hybrid seed took 32.67 s to create the canonical Git data, ext4 base, verification tree and immutable objects. The experiment started each API edit with that seed already available. Git deltas replay whole changed files. On a separate 96 MiB fixture, changing one byte of a header produced 10 KiB to replay. Changing one byte in a 32 MiB file produced 32.01 MiB. Editing one byte in each of 102 small files produced 6.44 MiB. An implementation should account for cumulative replay bytes and base preparation before deciding when to replace a base.

## Recovery and limitations

All four designs completed a checkpoint, rejected a stale ref update, restored the expected bytes and preserved the older fork in fresh guests. The hybrid turned injected corruption into EIO with a kernel verity report. A separate 4 MiB trial exported the committed Git objects, refs, image and descriptor from rt-pool-10. Rt-pool-8 received the identical artifact (SHA-256 fdea9c49817c87ef0938495b7374aacdd7b3dcdbf6a57c37abf0fa9a198bf9b9), independently booted both revisions and passed the corruption test. The experiment demonstrates portability across separate Sprites. Provider physical placement, abrupt power loss, network partition behavior and the production ref service were outside this drill.

Earlier runs hit a BusyBox tar compatibility error before checkpoint; the harness now invokes the packaged GNU tar by absolute path. Two further runs stalled during a cold mount: a 64 MiB hybrid recovery and an 8 MiB hybrid corruption probe. I stopped a separate 500 MiB disk fork after it spent 148 s without reaching first read. These are failures in addition to the completed trials above. Two 8 MiB repeats using a persistent HTTP origin passed all phases. That result does not establish the cause of the stalls or resolve their frequency.

For the pilot, qualify lazy authenticated block delivery under Firecracker before introducing a new storage service. The first comparison should retain existing Git commits and API writes, carry an immutable base across an edit, and include range-origin interruption and live checkpoint tests. A host checkout is the simpler alternative if warm locality dominates and the file transport performs well. The experiments cover an isolated writer with a stopped guest at publication. They do not measure concurrent merges, billing, live Bash durability latency or distributed commits.

See [per-trial data](results/trials.json), [replay sizes](results/churn.json), [peer recovery](results/peer-recovery.json), [mount failures and repeats](results/mount-failures.json), and [implementation and reproduction](README.md).
