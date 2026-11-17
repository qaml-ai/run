# Normal VM starts with prebuilt ext4 images

Source `76f136125550e33f7d32784b35093f6367a0488b`; qualification binary SHA256 `66ead1feab1103f59b2eb837a599187f74dd3ccb755624a955f274d545c7d4c8`.

Two order-reversed rounds ran on one physical Firecracker host. Each round used a one-file 4 KiB fixture plus new nominal 50/500 MiB random fixtures: 10,000 × 4 KiB files plus 1 MiB binaries (10 or 460). Each paired arm replayed the same committed version. Fresh host directories model empty local caches; S3 and the physical host were shared.

The pilot host was an m8id.xlarge. VMs used 2 vCPU and 2048 MiB RAM. All workspace disks were 64 GiB, matching the pilot serving unit, and held 4 KiB or 49.0625/499.0625 MiB of logical data. The bare daemon command defaults to 1024 MiB unless configured by its serving unit. Guest image and kernel digests were pinned in the captured runner.

All 70 timed startups passed full-file checksum/count assertions. Four changed/no-op checkpoint pairs passed; restored checkpoint files preserved executable mode and symlink target. Two distinct fault-injection images were rejected before becoming runnable. The captured restoration receipt is required by the checker.

The first-read timer starts before the ordinary VM-create request to a ready host and ends after a verified SHA256 read. Host-process initialization, including canonical blank-image creation, precedes it. First-miss includes synchronous image build and publication. API-edit/add use fresh host directories after the canonical API commit exists; API write latency is outside this timer. The checkpoint row times startup before the checkpoint RPCs; reported checkpoint stages appear separately.

| Size | Phase | Canonical seconds median [min–max] | Prebuilt seconds median [min–max] | Prebuilt change | n per arm |
|---|---|---:|---:|---:|---:|
| 4 KiB | first-miss | 0.664 [0.637–0.690] | 0.797 [0.756–0.838] | +20.1% | 2/2 |
| 4 KiB | local-hit | 0.337 [0.336–0.339] | 0.338 [0.334–0.343] | +0.3% | 2/2 |
| 4 KiB | remote-hit | 0.685 [0.684–0.686] | 0.932 [0.685–1.179] | +36.1% | 2/2 |
| 50 MiB | first-miss | 2.524 [2.321–2.728] | 4.577 [3.933–5.220] | +81.3% | 2/2 |
| 50 MiB | local-hit | 0.531 [0.530–0.533] | 0.556 [0.553–0.558] | +4.6% | 2/2 |
| 50 MiB | remote-hit | 2.310 [2.261–2.360] | 1.707 [1.701–1.713] | -26.1% | 2/2 |
| 50 MiB | api-edit | 2.683 [2.299–3.068] | 4.326 [3.307–5.344] | +61.2% | 2/2 |
| 50 MiB | api-add | 2.715 [2.362–3.068] | 4.198 [4.128–4.268] | +54.6% | 2/2 |
| 50 MiB | checkpoint | — | 1.442 [1.381–1.503] | — | 0/2 |
| 50 MiB | checkpoint-recovery | 2.304 [2.291–2.316] | 4.265 [3.710–4.820] | +85.1% | 2/2 |
| 50 MiB | checkpoint-remote | — | 1.464 [1.377–1.550] | — | 0/2 |
| 500 MiB | first-miss | 4.758 [4.705–4.812] | 12.459 [12.321–12.597] | +161.8% | 2/2 |
| 500 MiB | local-hit | 0.576 [0.551–0.601] | 0.559 [0.557–0.560] | -3.0% | 2/2 |
| 500 MiB | remote-hit | 5.198 [4.815–5.582] | 3.227 [3.165–3.289] | -37.9% | 2/2 |
| 500 MiB | api-edit | 5.230 [5.214–5.247] | 13.406 [13.097–13.714] | +156.3% | 2/2 |
| 500 MiB | api-add | 5.415 [5.097–5.733] | 12.719 [12.717–12.721] | +134.9% | 2/2 |
| 500 MiB | checkpoint | — | 3.410 [3.060–3.760] | — | 0/2 |
| 500 MiB | checkpoint-recovery | 4.991 [4.601–5.380] | 13.825 [12.200–15.451] | +177.0% | 2/2 |
| 500 MiB | checkpoint-remote | — | 4.174 [3.910–4.438] | — | 0/2 |

Values are medians and complete observed ranges of two runs; the JSON and CSV retain every per-phase value and boot stage. Positive percentages mean prebuilt was slower. The n column gives canonical/prebuilt counts.

The slowest new-image startup was round 1, 500 MiB, `checkpoint-recovery`: 15.450746 s to the first verified read, including 14.757253 s in the helper (7.550065 s build and 7.084125 s publication).

The slowest remote-mode startup was round 1, 500 MiB, `checkpoint-remote`: 4.438123 s to the first verified read, including 3.264618 s in the transfer/decode helper. That helper includes HEAD/range downloads, gzip decoding, hashing, sparse-file writes and fsync; the run did not measure their individual durations.

| Size | All successful remote-mode starts | First-read seconds median [min–max] | Transfer/decode seconds median [min–max] |
|---|---:|---:|---:|
| 4 KiB | 2 | 0.932 [0.685–1.179] | 0.300 [0.059–0.541] |
| 50 MiB | 6 | 1.526 [1.377–1.713] | 0.495 [0.418–0.603] |
| 500 MiB | 6 | 3.525 [3.060–4.438] | 2.511 [2.121–3.265] |

This remote group includes `remote-hit`, startup before `checkpoint`, and `checkpoint-remote`; it combines different committed trees. Its range describes every remote-mode observation in this run.

| Size | Producer phase | Build seconds | Publish seconds | Helper total seconds |
|---|---|---:|---:|---:|
| 4 KiB | first-miss | 0.190 | 0.130 | 0.331 |
| 50 MiB | first-miss | 2.645 | 1.177 | 3.909 |
| 50 MiB | api-edit | 2.915 | 0.607 | 3.608 |
| 50 MiB | api-add | 2.754 | 0.673 | 3.514 |
| 50 MiB | checkpoint-recovery | 2.821 | 0.650 | 3.564 |
| 500 MiB | first-miss | 6.655 | 4.978 | 11.755 |
| 500 MiB | api-edit | 7.357 | 5.181 | 12.697 |
| 500 MiB | api-add | 6.888 | 4.996 | 12.006 |
| 500 MiB | checkpoint-recovery | 6.987 | 6.017 | 13.127 |

Helper total includes lookup and local cache installation as well as build/publication. These costs are already inside first-read time; adding them again would double count.

| Size | Checkpoint | Freeze ms | Walk ms | Commit ms | CAS ms |
|---|---|---:|---:|---:|---:|
| 50 MiB | changed | 2704.000 | 25.000 | 37.635 | 70.669 |
| 50 MiB | unchanged | 81.000 | 20.000 | 0.000 | 0.000 |
| 500 MiB | changed | 4878.500 | 25.000 | 30.810 | 81.892 |
| 500 MiB | unchanged | 84.000 | 28.000 | 0.000 | 0.000 |

Checkpoint columns are the host’s reported stages, not an independently measured end-to-end RPC timer.

## Reproduce the report

```sh
python3 summarize.py raw/RUN_ID --output .
python3 summarize.py raw/RUN_ID --output . --check
```

The parser requires both complete 35-start matrices, paired canonical versions, successful boot/baseline/checkpoint receipts, expected build/remote/local behavior, two corruption refusals, exact fixture cleanup and the restoration receipt. It checks that the captured host is undrained, healthy and fully free. It reads captured artifacts only.

## Deployed normal-CLI canary

The separate public Worker/SDK canary passed two Bash sessions on distinct guests, a committed checkpoint, an API addition before the next start, exact compute settlement and owned account/storage cleanup. Its two ordinary-host image build receipts match this source. Model and Worker ingress time are outside the native timing tables above.

The two normal-host image helpers took 344.758/277.523 ms. Their compute usage reconciled at 22.406 seconds, 1027.330660 µUSD in agent usage and 1027 µUSD in the rounded ledger (2 events), stable across a later observation. The final receipts retain candidate `ee18bda5d8adc05a0a662712af5d65db6769662cf5d21bd8fd8712d30eb17707`, active/running, with all host slots free and healthy public Worker status.


## Raw evidence

- [binaries.sha256](raw/20261117T182347Z-76f13612/binaries.sha256): 84 bytes, SHA256 `f5515bffb7d276237789a5a0b04e35af2c8ace4fe5f047ed34cd9882c4facaa0`.
- [candidate-binaries.sha256](raw/20261117T182347Z-76f13612/candidate-binaries.sha256): 164 bytes, SHA256 `e2355c966e6bf4e0497236c608a04b9fba22e4b54d2ca075ea2e3140e82ad3de`.
- [ddb-cleanup.log](raw/20261117T182347Z-76f13612/ddb-cleanup.log): 598 bytes, SHA256 `34469d8b3f24086d4cc6ff1a93a9e7d42444f10e438e41fb57ce4e4384ab8955`.
- [fenced.json](raw/20261117T182347Z-76f13612/fenced.json): 176 bytes, SHA256 `132514baef7946dbad9966fba0c552015e3ecbf619f70c35cd659e95e6f839e2`.
- [host-logs.tar.gz](raw/20261117T182347Z-76f13612/host-logs.tar.gz): 15031 bytes, SHA256 `6b0db6642eea9d2908e849a208fb345584045e91a25c946b4a1083bea7cfbf8f`.
- [live-commit.txt](raw/20261117T182347Z-76f13612/live-commit.txt): 41 bytes, SHA256 `3c32afd566598bbc28bbeefb83c8e000a2aa31e817980114b19f7d316ad40f75`.
- [live-sha256.txt](raw/20261117T182347Z-76f13612/live-sha256.txt): 65 bytes, SHA256 `0ce457a5d9439ffcc8c61c782eead43a01ac266aac48699d3674c6a57baf2ba0`.
- [maintenance.log](raw/20261117T182347Z-76f13612/maintenance.log): 60277 bytes, SHA256 `456d9378d03fc5b4c251d8b1bb95d00cc991ebe9061f5965ea775502d43f4720`.
- [original.json](raw/20261117T182347Z-76f13612/original.json): 177 bytes, SHA256 `53252d92b108fe556ee32a6e5056d7b5f4a31fe9b94a57493ada08af9f5f2562`.
- [package.sha256](raw/20261117T182347Z-76f13612/package.sha256): 407 bytes, SHA256 `1bb0c8776b57e23121ed7375c6082feb2b732d500ce491684609ad996bb8a64b`.
- [pairs.log](raw/20261117T182347Z-76f13612/pairs.log): 33607 bytes, SHA256 `f49e513c55aab47651fbaec4fa3199b650dd0d3031b665005e866d3c3ab0cb28`.
- [pilot-iam-receipt.json](raw/20261117T182347Z-76f13612/pilot-iam-receipt.json): 2339 bytes, SHA256 `cb6a38e56e2588898637ed8e2b1cd41aa2af307b17cf89874f663c63c7e9389f`.
- [public-fenced.json](raw/20261117T182347Z-76f13612/public-fenced.json): 176 bytes, SHA256 `48397c953c521bcf90c53dee502bc801282df7d99354f394b1288eb2b118d2bd`.
- [public-final-host-row.json](raw/20261117T182347Z-76f13612/public-final-host-row.json): 177 bytes, SHA256 `3c4dccfcd8854a7925d80b6046e09ed0d57e5e5d56eef5a162822d01f1aa2259`.
- [public-final-public-health.json](raw/20261117T182347Z-76f13612/public-final-public-health.json): 58 bytes, SHA256 `04b5d4ad98085d9a9fa6da257977497fe2f2c6df58b5cc744597249ae1948a21`.
- [public-final-running-host.txt](raw/20261117T182347Z-76f13612/public-final-running-host.txt): 383 bytes, SHA256 `1a7763344ac89e196e4b7a91a028e4a79bb3cebe083ef221bd5e69ea7e4db5b7`.
- [public-install.log](raw/20261117T182347Z-76f13612/public-install.log): 123 bytes, SHA256 `79b7efa611b44f81761f2a96c9f4e7b9510a344505ece6f18fad2cb70a8844df`.
- [public-original.json](raw/20261117T182347Z-76f13612/public-original.json): 177 bytes, SHA256 `504aa8e5763ffa9263854b872c30e7b38de97d3668f46139bfc5af85eec43192`.
- [public-restored.json](raw/20261117T182347Z-76f13612/public-restored.json): 177 bytes, SHA256 `06ebe82abc4c8a7cdd6a1b82ac398f08b2ec5c200d5bc77ddfeaae0fc88240ab`.
- [public-smoke.jsonl](raw/20261117T182347Z-76f13612/public-smoke.jsonl): 4389 bytes, SHA256 `510f90be380daa4cd0d5641c2aadf3b5dc0966f6ca07ebdc418935453ef9236e`.
- [public-summary.json](raw/20261117T182347Z-76f13612/public-summary.json): 5510 bytes, SHA256 `936d16d8380ae663658117f617d3cc55d5001829225be321fd5fb9504598290c`.
- [restored.json](raw/20261117T182347Z-76f13612/restored.json): 177 bytes, SHA256 `b223e50f8129056b3c237f65c2055d8c6962df213c023ce5b8b9adbb1ce24d41`.
- [revision.txt](raw/20261117T182347Z-76f13612/revision.txt): 41 bytes, SHA256 `8805668dd0a8fde5334b1440213d6f3cecddc5254e51f19cb7248d92d130ea47`.
- [run-id.txt](raw/20261117T182347Z-76f13612/run-id.txt): 26 bytes, SHA256 `512f05c28658d873ab4268dc0aa35dc2e63ff3a68fa79056c19c97a556f592a7`.
- [run-qualification.sh](raw/20261117T182347Z-76f13612/run-qualification.sh): 2359 bytes, SHA256 `3b418bc97e2ec071e7f96369c9626bc7399ad445b747bf89ba2f401fbe0486be`.
- [s3-cleanup.log](raw/20261117T182347Z-76f13612/s3-cleanup.log): 79 bytes, SHA256 `3f67eee15dca77d161b479efdd86b87014fb481e0560e892ed2ea28610ebcd85`.
- [summary.json](raw/20261117T182347Z-76f13612/summary.json): 25612 bytes, SHA256 `bc2acccfb7becdf10dc5162c8f99dfccef629787cd56c4a517492e5c9ea5131d`.
