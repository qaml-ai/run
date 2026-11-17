# Normal VM starts with prebuilt ext4 images

Source `249e5efc5bbf2b3521cef283d14006f4ae0a6b19`; qualification binary SHA256 `9790b24587bb682c7ff9befa85a9e253f94ab3a764d8ebb6a788daee5b37049b`.

Two order-reversed rounds ran on one physical Firecracker host. Each nominal 50/500 MiB size used a new random fixture: 10,000 × 4 KiB files plus 1 MiB binaries (10 or 460). Each paired arm replayed the same committed version. Fresh host directories model empty local caches; S3 and the physical host were shared.

The pilot host was an m8id.xlarge. VMs used 2 vCPU and 2048 MiB RAM. Workspace virtual disks were 1074/1524 MiB (`nominalMiB + 1024`), holding 49.0625/499.0625 MiB of logical data. The normal daemon’s default workspace disk is 1024 MiB. Guest image and kernel digests were pinned in the captured runner.

All 58 timed startups passed full-file checksum/count assertions. Four changed/no-op checkpoint pairs passed; restored checkpoint files preserved executable mode and symlink target. Two distinct fault-injection images were rejected before becoming runnable. The captured restoration receipt is required by the checker.

The first-read timer starts before the ordinary VM-create request and ends after a verified SHA256 read. First-miss includes synchronous image build and publication. API-edit/add use fresh host directories. The checkpoint row times startup before the checkpoint RPCs; reported checkpoint stages appear separately.

| Size | Phase | Canonical seconds median [min–max] | Prebuilt seconds median [min–max] | Prebuilt change | n per arm |
|---|---|---:|---:|---:|---:|
| 50 MiB | first-miss | 2.236 [2.194–2.277] | 4.754 [4.164–5.344] | +112.7% | 2/2 |
| 50 MiB | local-hit | 0.542 [0.539–0.545] | 0.559 [0.556–0.561] | +3.1% | 2/2 |
| 50 MiB | remote-hit | 2.348 [2.184–2.511] | 2.118 [2.063–2.174] | -9.8% | 2/2 |
| 50 MiB | api-edit | 2.314 [2.313–2.315] | 4.392 [4.067–4.717] | +89.8% | 2/2 |
| 50 MiB | api-add | 2.353 [2.145–2.560] | 4.299 [4.290–4.309] | +82.8% | 2/2 |
| 50 MiB | checkpoint | — | 2.153 [2.007–2.299] | — | 0/2 |
| 50 MiB | checkpoint-recovery | 2.314 [2.164–2.463] | 4.590 [4.419–4.761] | +98.4% | 2/2 |
| 50 MiB | checkpoint-remote | — | 2.072 [2.026–2.118] | — | 0/2 |
| 500 MiB | first-miss | 5.345 [5.324–5.366] | 13.971 [13.946–13.997] | +161.4% | 2/2 |
| 500 MiB | local-hit | 0.545 [0.534–0.556] | 0.593 [0.555–0.631] | +8.7% | 2/2 |
| 500 MiB | remote-hit | 6.473 [6.415–6.531] | 3.810 [3.600–4.020] | -41.1% | 2/2 |
| 500 MiB | api-edit | 5.428 [5.236–5.620] | 13.969 [12.737–15.202] | +157.3% | 2/2 |
| 500 MiB | api-add | 5.410 [5.375–5.445] | 13.785 [13.564–14.007] | +154.8% | 2/2 |
| 500 MiB | checkpoint | — | 4.354 [3.857–4.851] | — | 0/2 |
| 500 MiB | checkpoint-recovery | 5.391 [4.843–5.939] | 13.681 [13.325–14.037] | +153.8% | 2/2 |
| 500 MiB | checkpoint-remote | — | 8.539 [3.989–13.088] | — | 0/2 |

Values are medians and complete observed ranges of two runs; the JSON and CSV retain every per-phase value and boot stage. Positive percentages mean prebuilt was slower. The n column gives canonical/prebuilt counts.

The slowest remote-mode startup was round 2, 500 MiB, `checkpoint-remote`: 13.088330 s to the first verified read, including 11.999569 s in the transfer/decode helper. That helper includes HEAD/range downloads, gzip decoding, hashing, sparse-file writes and fsync; the run did not measure their individual durations.

| Size | All successful remote-mode starts | First-read seconds median [min–max] | Transfer/decode seconds median [min–max] |
|---|---:|---:|---:|
| 50 MiB | 6 | 2.091 [2.007–2.299] | 1.140 [1.077–1.205] |
| 500 MiB | 6 | 4.004 [3.600–13.088] | 2.880 [2.689–12.000] |

This remote group includes `remote-hit`, startup before `checkpoint`, and `checkpoint-remote`; it combines different committed trees. Its range describes every remote-mode observation in this run.

| Size | Producer phase | Build seconds | Publish seconds | Helper total seconds |
|---|---|---:|---:|---:|
| 50 MiB | first-miss | 3.318 | 0.654 | 4.062 |
| 50 MiB | api-edit | 2.994 | 0.616 | 3.694 |
| 50 MiB | api-add | 2.892 | 0.597 | 3.579 |
| 50 MiB | checkpoint-recovery | 3.137 | 0.652 | 3.877 |
| 500 MiB | first-miss | 8.097 | 5.006 | 13.231 |
| 500 MiB | api-edit | 6.884 | 6.174 | 13.218 |
| 500 MiB | api-add | 7.887 | 4.998 | 13.049 |
| 500 MiB | checkpoint-recovery | 7.807 | 5.011 | 12.942 |

Helper total includes lookup and local cache installation as well as build/publication. These costs are already inside first-read time; adding them again would double count.

| Size | Checkpoint | Freeze ms | Walk ms | Commit ms | CAS ms |
|---|---|---:|---:|---:|---:|
| 50 MiB | changed | 2683.000 | 29.500 | 37.002 | 67.559 |
| 50 MiB | unchanged | 75.500 | 23.500 | 0.000 | 0.000 |
| 500 MiB | changed | 3820.500 | 29.500 | 32.556 | 57.480 |
| 500 MiB | unchanged | 71.500 | 22.500 | 0.000 | 0.000 |

Checkpoint columns are the host’s reported stages, not an independently measured end-to-end RPC timer.

## Reproduce the report

```sh
python3 summarize.py raw/RUN_ID --output .
python3 summarize.py raw/RUN_ID --output . --check
```

The parser requires both complete 29-start matrices, paired canonical versions, successful boot/baseline/checkpoint receipts, expected build/remote/local behavior, two corruption refusals, exact fixture cleanup and the restoration receipt. It checks that the captured host is undrained, healthy and fully free. It reads captured artifacts only.

## Raw evidence

- [binaries.sha256](raw/20261117T175551Z-249e5efc/binaries.sha256): 84 bytes, SHA256 `9e314ec04c5147f3d1995e33830ce6ff65deb73ce66dadcf2423b5fa35032c5b`.
- [ddb-cleanup.log](raw/20261117T175551Z-249e5efc/ddb-cleanup.log): 406 bytes, SHA256 `2fdee84d48841c39eb233d1106bbb6a8e25a1adbf63e25ac654b521836ea65c3`.
- [fenced.json](raw/20261117T175551Z-249e5efc/fenced.json): 176 bytes, SHA256 `6b4771d2788b48b9279fa7276c1fd0fc3072b4e3ee86d9ff2d0e88b83412b04e`.
- [host-logs.tar.gz](raw/20261117T175551Z-249e5efc/host-logs.tar.gz): 12945 bytes, SHA256 `85b9c56d7876fe50b24e271f9cfc56806cf4917ecf9bd156509feaa7ee700eac`.
- [live-commit.txt](raw/20261117T175551Z-249e5efc/live-commit.txt): 41 bytes, SHA256 `3c32afd566598bbc28bbeefb83c8e000a2aa31e817980114b19f7d316ad40f75`.
- [live-sha256.txt](raw/20261117T175551Z-249e5efc/live-sha256.txt): 65 bytes, SHA256 `0ce457a5d9439ffcc8c61c782eead43a01ac266aac48699d3674c6a57baf2ba0`.
- [maintenance.log](raw/20261117T175551Z-249e5efc/maintenance.log): 46497 bytes, SHA256 `2b6629f1b2cb8bd45b07fc98b45a33db49af047ee4934f8e3d6463fad93666a4`.
- [original.json](raw/20261117T175551Z-249e5efc/original.json): 177 bytes, SHA256 `a481e20f2b3ca75e1565d897c6b11e149dac67e2595bec6f2b10f6064d73bdb1`.
- [package.sha256](raw/20261117T175551Z-249e5efc/package.sha256): 407 bytes, SHA256 `2c820ec3278168df28c7e3739a02d5233d45d28d4fdf59808704b9c2de698f5d`.
- [pairs.log](raw/20261117T175551Z-249e5efc/pairs.log): 26712 bytes, SHA256 `c0f9ee2e8808e6bbd26367204964bf71d07b8e8d6998fae63abbef05476cd885`.
- [pilot-iam-receipt.json](raw/20261117T175551Z-249e5efc/pilot-iam-receipt.json): 2339 bytes, SHA256 `cb6a38e56e2588898637ed8e2b1cd41aa2af307b17cf89874f663c63c7e9389f`.
- [restored.json](raw/20261117T175551Z-249e5efc/restored.json): 177 bytes, SHA256 `341b5d002400336f0a902be4f3e7bc11d4c17127fbcb89094ea68f91fa908417`.
- [revision.txt](raw/20261117T175551Z-249e5efc/revision.txt): 41 bytes, SHA256 `330fcf2ad9a9066039a45bc0207969beec4e13bcc8875a2be48a7109e401a91c`.
- [run-id.txt](raw/20261117T175551Z-249e5efc/run-id.txt): 26 bytes, SHA256 `ff5d92680752b707378713bbcf56580d2e3fbaaf1738b07c65f74a7620759c69`.
- [run-qualification.sh](raw/20261117T175551Z-249e5efc/run-qualification.sh): 2359 bytes, SHA256 `3b418bc97e2ec071e7f96369c9626bc7399ad445b747bf89ba2f401fbe0486be`.
- [s3-cleanup.log](raw/20261117T175551Z-249e5efc/s3-cleanup.log): 79 bytes, SHA256 `647491b16a561e151ae65d5650a46205a5c63b11a6f15120185a23481ad8c20f`.
- [summary.json](raw/20261117T175551Z-249e5efc/summary.json): 18919 bytes, SHA256 `a724a9c2bece4e3764027c3e07e087944c7d2a9d22c3b59d2c8b66f3ca9cf91e`.
