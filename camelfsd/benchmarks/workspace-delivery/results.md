# Workspace delivery prototypes

Generated 2026-11-17T16:17:51.267411+00:00.

Recorded 23 VM trials and 69 phases, plus the separate two-Sprite HTTP experiment.

Canonical parallel restore is the simplest choice when commits change frequently. Every derived artifact increased the measured first-miss time once full preparation and upload were included.

For repeated cold restores of the same commit, parallel clean images had the fastest ready-artifact times: 1.404/3.102 seconds at 50/500 MiB, with 2.928/14.682 seconds of preparation per tree. Initial-phase arithmetic suggests about 4/21 cold uses to recover that preparation. Gzip apply streams reuse the existing guest receiver and improved the artificially compressible source fixture from 2.303 to 1.647 seconds, with 0.823 seconds of preparation; that fixture suggests roughly two cold uses.

The one bulk 1 MiB bundle layout was slower than the 500 MiB baseline. The warm Git service measured file and snapshot HTTP transfer, so its results alone do not establish a faster VM restore or a simpler replacement for the current API cache.

Each VM trial used a fresh daemon process, empty workspace cache and fresh local metadata on the same physical Firecracker host. Canonical objects were in S3. First read verifies the requested file. Initial markers are 4 KiB, and API phases verify shorter new text. Image times include downloading, verifying and restoring the image before VM creation. Full workspace hydration precedes guest execution. Every phase checked the full file count.

The random fixture has 10,000 random 4 KiB files and 10 or 460 random 1 MiB binaries. Labels 50/500 MiB represent 49.0625/499.0625 MiB of initial payload and 10,010/10,460 files. API edit replaces the marker, and API add creates `src/api-added.ts`. The source fixture replaces only small files with repeated per-path TypeScript-like text. It is artificially compressible and leaves large binaries random.

| Series | Run | Expected trials / phases | Recorded trials / phases |
| --- | --- | --- | --- |
| packed | `20261117T153951Z-f8831868` | 12 trials, 36 phases | 12 / 36 |
| ranges-images | `20261117T155154Z-49671f85` | 6 trials, 18 phases | 6 / 18 |
| source | `20261117T154851Z-1a566035` | 4 trials, 12 phases | 4 / 12 |
| medium | `20261117T160805Z-21f994ca` | 1 trials, 3 phases | 1 / 3 |

## Combined comparison

Medians pool initial, API edit and API addition phases. Preparation is a separate cost for each committed tree.

| Fixture | MiB | Arm | Trials / phases | Cold read seconds | Prepare seconds | Constraint |
| --- | --- | --- | --- | --- | --- | --- |
| random | 50 | baseline | 2 / 6 | 2.220 | 0.000 | Canonical parallel restore |
| random | 50 | image | 1 / 3 | 1.624 | 2.991 | mkfs and gzip producer, full rebuild |
| random | 50 | imageparallel | 1 / 3 | 1.404 | 2.928 | mkfs and gzip producer, range GETs |
| random | 50 | packedgzip | 2 / 6 | 2.301 | 1.344 | Single GET, gzip, full rebuild |
| random | 50 | packedparallel | 1 / 3 | 1.822 | 1.283 | 8 MiB range GETs, full rebuild |
| random | 50 | packedplain | 2 / 6 | 2.202 | 1.275 | Single GET, verification spools, full rebuild |
| random | 500 | baseline | 2 / 6 | 4.901 | 0.000 | Canonical parallel restore |
| random | 500 | bundlemedium | 1 / 3 | 6.488 | 0.000 | 1 MiB cutoff, one bulk asset publication |
| random | 500 | image | 1 / 3 | 10.071 | 15.011 | mkfs and gzip producer, full rebuild |
| random | 500 | imageparallel | 1 / 3 | 3.102 | 14.682 | mkfs and gzip producer, range GETs |
| random | 500 | packedgzip | 2 / 6 | 10.881 | 6.639 | Single GET, gzip, full rebuild |
| random | 500 | packedparallel | 1 / 3 | 6.111 | 6.948 | 8 MiB range GETs, full rebuild |
| random | 500 | packedplain | 2 / 6 | 9.829 | 6.808 | Single GET, verification spools, full rebuild |
| source | 50 | baseline | 2 / 6 | 2.303 | 0.000 | Canonical parallel restore |
| source | 50 | packedgzip | 2 / 6 | 1.647 | 0.823 | Single GET, gzip, full rebuild |

## First verified read

Seconds shown as median [minimum, maximum]. Combined pools the three phases' samples. Preparation and API writes are excluded here and reported below.

| Fixture | MiB label | Arm | Phase | n | Seconds |
| --- | --- | --- | --- | --- | --- |
| random | 50 | baseline | api-add | 2 | 2.213 [2.190, 2.235] |
| random | 50 | baseline | api-edit | 2 | 2.335 [2.204, 2.465] |
| random | 50 | baseline | combined | 6 | 2.220 [2.088, 2.465] |
| random | 50 | baseline | initial | 2 | 2.182 [2.088, 2.277] |
| random | 50 | image | api-add | 1 | 1.673 [1.673, 1.673] |
| random | 50 | image | api-edit | 1 | 1.624 [1.624, 1.624] |
| random | 50 | image | combined | 3 | 1.624 [1.560, 1.673] |
| random | 50 | image | initial | 1 | 1.560 [1.560, 1.560] |
| random | 50 | imageparallel | api-add | 1 | 1.706 [1.706, 1.706] |
| random | 50 | imageparallel | api-edit | 1 | 1.404 [1.404, 1.404] |
| random | 50 | imageparallel | combined | 3 | 1.404 [1.387, 1.706] |
| random | 50 | imageparallel | initial | 1 | 1.387 [1.387, 1.387] |
| random | 50 | packedgzip | api-add | 2 | 2.367 [2.344, 2.389] |
| random | 50 | packedgzip | api-edit | 2 | 2.666 [2.258, 3.074] |
| random | 50 | packedgzip | combined | 6 | 2.301 [2.065, 3.074] |
| random | 50 | packedgzip | initial | 2 | 2.068 [2.065, 2.071] |
| random | 50 | packedparallel | api-add | 1 | 1.755 [1.755, 1.755] |
| random | 50 | packedparallel | api-edit | 1 | 1.822 [1.822, 1.822] |
| random | 50 | packedparallel | combined | 3 | 1.822 [1.755, 1.956] |
| random | 50 | packedparallel | initial | 1 | 1.956 [1.956, 1.956] |
| random | 50 | packedplain | api-add | 2 | 2.438 [2.013, 2.864] |
| random | 50 | packedplain | api-edit | 2 | 2.270 [2.132, 2.409] |
| random | 50 | packedplain | combined | 6 | 2.202 [2.013, 2.864] |
| random | 50 | packedplain | initial | 2 | 2.161 [2.050, 2.273] |
| random | 500 | baseline | api-add | 2 | 5.440 [4.774, 6.106] |
| random | 500 | baseline | api-edit | 2 | 5.789 [5.028, 6.550] |
| random | 500 | baseline | combined | 6 | 4.901 [4.582, 6.550] |
| random | 500 | baseline | initial | 2 | 4.604 [4.582, 4.625] |
| random | 500 | bundlemedium | api-add | 1 | 11.908 [11.908, 11.908] |
| random | 500 | bundlemedium | api-edit | 1 | 5.376 [5.376, 5.376] |
| random | 500 | bundlemedium | combined | 3 | 6.488 [5.376, 11.908] |
| random | 500 | bundlemedium | initial | 1 | 6.488 [6.488, 6.488] |
| random | 500 | image | api-add | 1 | 10.071 [10.071, 10.071] |
| random | 500 | image | api-edit | 1 | 10.338 [10.338, 10.338] |
| random | 500 | image | combined | 3 | 10.071 [8.322, 10.338] |
| random | 500 | image | initial | 1 | 8.322 [8.322, 8.322] |
| random | 500 | imageparallel | api-add | 1 | 3.102 [3.102, 3.102] |
| random | 500 | imageparallel | api-edit | 1 | 2.932 [2.932, 2.932] |
| random | 500 | imageparallel | combined | 3 | 3.102 [2.932, 3.909] |
| random | 500 | imageparallel | initial | 1 | 3.909 [3.909, 3.909] |
| random | 500 | packedgzip | api-add | 2 | 10.463 [9.906, 11.021] |
| random | 500 | packedgzip | api-edit | 2 | 11.132 [10.417, 11.848] |
| random | 500 | packedgzip | combined | 6 | 10.881 [9.906, 12.875] |
| random | 500 | packedgzip | initial | 2 | 11.808 [10.741, 12.875] |
| random | 500 | packedparallel | api-add | 1 | 6.111 [6.111, 6.111] |
| random | 500 | packedparallel | api-edit | 1 | 6.137 [6.137, 6.137] |
| random | 500 | packedparallel | combined | 3 | 6.111 [5.864, 6.137] |
| random | 500 | packedparallel | initial | 1 | 5.864 [5.864, 5.864] |
| random | 500 | packedplain | api-add | 2 | 9.804 [9.370, 10.237] |
| random | 500 | packedplain | api-edit | 2 | 10.056 [9.416, 10.696] |
| random | 500 | packedplain | combined | 6 | 9.829 [9.370, 13.353] |
| random | 500 | packedplain | initial | 2 | 11.386 [9.420, 13.353] |
| source | 50 | baseline | api-add | 2 | 2.341 [2.105, 2.577] |
| source | 50 | baseline | api-edit | 2 | 2.435 [2.313, 2.556] |
| source | 50 | baseline | combined | 6 | 2.303 [2.105, 2.577] |
| source | 50 | baseline | initial | 2 | 2.234 [2.175, 2.293] |
| source | 50 | packedgzip | api-add | 2 | 1.662 [1.627, 1.698] |
| source | 50 | packedgzip | api-edit | 2 | 1.665 [1.619, 1.711] |
| source | 50 | packedgzip | combined | 6 | 1.647 [1.593, 1.711] |
| source | 50 | packedgzip | initial | 2 | 1.630 [1.593, 1.667] |

## Artifact preparation and API writes

Preparation includes artifact build and upload. API mutation timing covers signed Storage API blob upload and commit creation. The fixture selects that commit directly for boot and excludes branch-ref CAS and public runtime routing. The last column adds API mutation, preparation, and first read for each sample before aggregation. It represents a serialized fixture operation that needs a new artifact. Background preparation would move the preparation cost outside that operation.

| Fixture | MiB | Arm | Phase | Prepare seconds | Stored MiB | API write ms | API + prepare + read seconds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| random | 50 | baseline | api-add | 0.000 [0.000, 0.000] | — | 125.435 [103.603, 147.267] | 2.338 [2.338, 2.339] |
| random | 50 | baseline | api-edit | 0.000 [0.000, 0.000] | — | 262.926 [256.569, 269.283] | 2.597 [2.461, 2.734] |
| random | 50 | baseline | initial | 0.000 [0.000, 0.000] | — | 0.000 [0.000, 0.000] | 2.182 [2.088, 2.277] |
| random | 50 | image | api-add | 3.053 [3.053, 3.053] | 50.950 | 108.310 [108.310, 108.310] | 4.835 [4.835, 4.835] |
| random | 50 | image | api-edit | 2.729 [2.729, 2.729] | 50.953 | 200.846 [200.846, 200.846] | 4.554 [4.554, 4.554] |
| random | 50 | image | initial | 2.991 [2.991, 2.991] | 50.955 | 0.000 [0.000, 0.000] | 4.551 [4.551, 4.551] |
| random | 50 | imageparallel | api-add | 2.891 [2.891, 2.891] | 50.940 | 111.073 [111.073, 111.073] | 4.708 [4.708, 4.708] |
| random | 50 | imageparallel | api-edit | 2.928 [2.928, 2.928] | 50.952 | 225.925 [225.925, 225.925] | 4.557 [4.557, 4.557] |
| random | 50 | imageparallel | initial | 2.979 [2.979, 2.979] | 50.958 | 0.000 [0.000, 0.000] | 4.366 [4.366, 4.366] |
| random | 50 | packedgzip | api-add | 1.277 [1.154, 1.399] | 50.046 | 159.566 [127.933, 191.199] | 3.803 [3.627, 3.979] |
| random | 50 | packedgzip | api-edit | 1.206 [1.123, 1.289] | 50.046 | 114.453 [110.959, 117.948] | 3.987 [3.492, 4.481] |
| random | 50 | packedgzip | initial | 1.523 [1.474, 1.571] | 50.050 | 0.000 [0.000, 0.000] | 3.591 [3.540, 3.642] |
| random | 50 | packedparallel | api-add | 1.283 [1.283, 1.283] | 50.816 | 118.641 [118.641, 118.641] | 3.157 [3.157, 3.157] |
| random | 50 | packedparallel | api-edit | 1.209 [1.209, 1.209] | 50.816 | 126.782 [126.782, 126.782] | 3.158 [3.158, 3.158] |
| random | 50 | packedparallel | initial | 1.460 [1.460, 1.460] | 50.819 | 0.000 [0.000, 0.000] | 3.416 [3.416, 3.416] |
| random | 50 | packedplain | api-add | 1.256 [1.180, 1.331] | 50.816 | 120.760 [119.357, 122.163] | 3.815 [3.315, 4.315] |
| random | 50 | packedplain | api-edit | 1.190 [1.161, 1.218] | 50.816 | 106.120 [102.559, 109.682] | 3.566 [3.460, 3.673] |
| random | 50 | packedplain | initial | 2.076 [1.688, 2.463] | 50.819 | 0.000 [0.000, 0.000] | 4.237 [3.961, 4.513] |
| random | 500 | baseline | api-add | 0.000 [0.000, 0.000] | — | 129.383 [126.497, 132.269] | 5.569 [4.906, 6.232] |
| random | 500 | baseline | api-edit | 0.000 [0.000, 0.000] | — | 237.598 [231.012, 244.184] | 6.027 [5.272, 6.781] |
| random | 500 | baseline | initial | 0.000 [0.000, 0.000] | — | 0.000 [0.000, 0.000] | 4.604 [4.582, 4.625] |
| random | 500 | bundlemedium | api-add | 0.000 [0.000, 0.000] | — | 116.743 [116.743, 116.743] | 12.025 [12.025, 12.025] |
| random | 500 | bundlemedium | api-edit | 0.000 [0.000, 0.000] | — | 209.477 [209.477, 209.477] | 5.585 [5.585, 5.585] |
| random | 500 | bundlemedium | initial | 0.000 [0.000, 0.000] | — | 0.000 [0.000, 0.000] | 6.488 [6.488, 6.488] |
| random | 500 | image | api-add | 15.291 [15.291, 15.291] | 500.912 | 209.187 [209.187, 209.187] | 25.571 [25.571, 25.571] |
| random | 500 | image | api-edit | 14.851 [14.851, 14.851] | 500.915 | 310.056 [310.056, 310.056] | 25.499 [25.499, 25.499] |
| random | 500 | image | initial | 15.011 [15.011, 15.011] | 500.919 | 0.000 [0.000, 0.000] | 23.333 [23.333, 23.333] |
| random | 500 | imageparallel | api-add | 14.682 [14.682, 14.682] | 500.901 | 148.815 [148.815, 148.815] | 17.933 [17.933, 17.933] |
| random | 500 | imageparallel | api-edit | 16.177 [16.177, 16.177] | 500.911 | 210.006 [210.006, 210.006] | 19.319 [19.319, 19.319] |
| random | 500 | imageparallel | initial | 14.391 [14.391, 14.391] | 500.919 | 0.000 [0.000, 0.000] | 18.300 [18.300, 18.300] |
| random | 500 | packedgzip | api-add | 6.689 [6.554, 6.825] | 500.123 | 134.825 [131.118, 138.532] | 17.288 [16.863, 17.713] |
| random | 500 | packedgzip | api-edit | 6.485 [6.362, 6.607] | 500.123 | 120.551 [109.118, 131.984] | 17.737 [16.888, 18.587] |
| random | 500 | packedgzip | initial | 6.702 [6.671, 6.734] | 500.127 | 0.000 [0.000, 0.000] | 18.511 [17.412, 19.609] |
| random | 500 | packedparallel | api-add | 7.927 [7.927, 7.927] | 500.896 | 173.222 [173.222, 173.222] | 14.211 [14.211, 14.211] |
| random | 500 | packedparallel | api-edit | 6.866 [6.866, 6.866] | 500.895 | 128.320 [128.320, 128.320] | 13.131 [13.131, 13.131] |
| random | 500 | packedparallel | initial | 6.948 [6.948, 6.948] | 500.899 | 0.000 [0.000, 0.000] | 12.812 [12.812, 12.812] |
| random | 500 | packedplain | api-add | 6.785 [6.587, 6.984] | 500.896 | 132.913 [131.757, 134.070] | 16.722 [16.091, 17.353] |
| random | 500 | packedplain | api-edit | 6.582 [6.533, 6.631] | 500.895 | 121.040 [116.725, 125.356] | 16.759 [16.066, 17.452] |
| random | 500 | packedplain | initial | 7.080 [7.030, 7.131] | 500.899 | 0.000 [0.000, 0.000] | 18.467 [16.550, 20.383] |
| source | 50 | baseline | api-add | 0.000 [0.000, 0.000] | — | 118.734 [112.222, 125.246] | 2.460 [2.230, 2.689] |
| source | 50 | baseline | api-edit | 0.000 [0.000, 0.000] | — | 249.755 [229.898, 269.613] | 2.684 [2.582, 2.786] |
| source | 50 | baseline | initial | 0.000 [0.000, 0.000] | — | 0.000 [0.000, 0.000] | 2.234 [2.175, 2.293] |
| source | 50 | packedgzip | api-add | 0.735 [0.701, 0.769] | 10.682 | 248.247 [143.549, 352.945] | 2.645 [2.542, 2.749] |
| source | 50 | packedgzip | api-edit | 0.997 [0.709, 1.286] | 10.683 | 136.641 [133.586, 139.696] | 2.799 [2.468, 3.131] |
| source | 50 | packedgzip | initial | 0.913 [0.877, 0.949] | 10.684 | 0.000 [0.000, 0.000] | 2.543 [2.542, 2.544] |

## First miss and repeated use

Approximate calculations use initial-phase medians. First miss adds a complete build/upload to the cold first read. Break-even compares one preparation plus N cold restores against N baseline cold restores of the same commit. It assumes the artifact remains available and ignores additional operational costs. Some arms ran in a later series with fewer repetitions, so these are arithmetic estimates rather than paired repeated-use measurements.

| Fixture | MiB | Arm | Baseline cold seconds | Prepared cold seconds | Prepare seconds | First miss seconds | Approximate cold uses to break even |
| --- | --- | --- | --- | --- | --- | --- | --- |
| random | 50 | image | 2.182 | 1.560 | 2.991 | 4.551 | 5 |
| random | 50 | imageparallel | 2.182 | 1.387 | 2.979 | 4.366 | 4 |
| random | 50 | packedgzip | 2.182 | 2.068 | 1.523 | 3.591 | 14 |
| random | 50 | packedparallel | 2.182 | 1.956 | 1.460 | 3.416 | 7 |
| random | 50 | packedplain | 2.182 | 2.161 | 2.076 | 4.237 | 100 |
| random | 500 | bundlemedium | 4.604 | 6.488 | 0.000 | 6.488 | No saving observed |
| random | 500 | image | 4.604 | 8.322 | 15.011 | 23.333 | No saving observed |
| random | 500 | imageparallel | 4.604 | 3.909 | 14.391 | 18.300 | 21 |
| random | 500 | packedgzip | 4.604 | 11.808 | 6.702 | 18.511 | No saving observed |
| random | 500 | packedparallel | 4.604 | 5.864 | 6.948 | 12.812 | No saving observed |
| random | 500 | packedplain | 4.604 | 11.386 | 7.080 | 18.467 | No saving observed |
| source | 50 | packedgzip | 2.234 | 1.630 | 0.913 | 2.543 | 2 |

## Canonical fixture publication

One seed measurement per trial includes fixture byte generation, canonical uploads, locator checks and tree import. It excludes derived artifact preparation. Seeding is a synthetic bulk-publication setup cost, and these values are not ordinary API-write latency.

| Fixture | MiB | Arm | Trials | Seed seconds, median [min, max] |
| --- | --- | --- | --- | --- |
| random | 50 | baseline | 2 | 23.849 [23.145, 24.553] |
| random | 50 | image | 1 | 24.240 [24.240, 24.240] |
| random | 50 | imageparallel | 1 | 27.607 [27.607, 27.607] |
| random | 50 | packedgzip | 2 | 23.366 [22.174, 24.558] |
| random | 50 | packedparallel | 1 | 23.113 [23.113, 23.113] |
| random | 50 | packedplain | 2 | 25.320 [24.873, 25.768] |
| random | 500 | baseline | 2 | 25.236 [24.848, 25.625] |
| random | 500 | bundlemedium | 1 | 34.594 [34.594, 34.594] |
| random | 500 | image | 1 | 24.395 [24.395, 24.395] |
| random | 500 | imageparallel | 1 | 24.985 [24.985, 24.985] |
| random | 500 | packedgzip | 2 | 25.781 [24.237, 27.325] |
| random | 500 | packedparallel | 1 | 24.496 [24.496, 24.496] |
| random | 500 | packedplain | 2 | 25.174 [23.970, 26.377] |
| source | 50 | baseline | 2 | 24.044 [21.975, 26.112] |
| source | 50 | packedgzip | 2 | 23.377 [23.262, 23.491] |

The medium-bundle candidate uses fresh synthetic fixtures, changes the locator contract to cover blobs through 1 MiB, and stages all asset files in one publication into 8 MiB packs. Individual 1 MiB API uploads would create singleton packs. It has no separate whole-tree artifact preparation, and its canonical publication cost still applies. One 500 MiB trial measured this bulk-publication pack layout. A separate deliberately interleaved 272 MiB test fetched about 1,016 MiB while crossing bounded apply windows. Ordinary ordered checkpoint spool windows can produce different pack locality, so that amplification does not describe every medium-bundle layout.

## Restore breakdown

Combined-phase medians in milliseconds. Packed fetch includes stored-byte verification, decoded verification uses a second spool, and guest send includes the existing guest apply stream. Image transfer/restore combines GET, verification, sparse decode and cache publication. Baseline payload requests include loose GETs, full pack GETs and member range GETs. These are payload counts, excluding metadata requests. Image request counts are inferred from the selected single-GET or 8 MiB range configuration and are recorded separately as `expectedPayloadGETCount` in JSON/CSV. Full precision, ranges, counts and additional boot/build stages are in `results.json` and `phases.csv`.

| Fixture | MiB | Arm | Fetch + stored verification | Decoded verification | Guest send | Image transfer + restore | Locator | Payload requests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| random | 50 | baseline | — | — | — | — | 246.000 [213.000, 272.000] | 16.000 [15.000, 17.000] |
| random | 50 | image | — | — | — | 735.000 [731.000, 736.000] | — | — |
| random | 50 | imageparallel | — | — | — | 489.000 [416.000, 507.000] | — | — |
| random | 50 | packedgzip | 797.942 [592.092, 1531.272] | 49.337 [48.429, 50.768] | 715.903 [704.957, 742.857] | — | — | 1.000 [1.000, 1.000] |
| random | 50 | packedparallel | 335.490 [241.869, 420.353] | 42.540 [42.433, 42.668] | 735.572 [724.124, 758.830] | — | — | 7.000 [7.000, 7.000] |
| random | 50 | packedplain | 697.603 [547.709, 1301.366] | 43.164 [42.510, 43.565] | 719.263 [688.779, 777.617] | — | — | 1.000 [1.000, 1.000] |
| random | 500 | baseline | — | — | — | — | 213.000 [197.000, 237.000] | 466.000 [465.000, 467.000] |
| random | 500 | bundlemedium | — | — | — | — | 234.000 [209.000, 256.000] | 234.000 [233.000, 235.000] |
| random | 500 | image | — | — | — | 8697.000 [7385.000, 9417.000] | — | — |
| random | 500 | imageparallel | — | — | — | 2166.000 [1944.000, 2861.000] | — | — |
| random | 500 | packedgzip | 5756.565 [5427.726, 8906.775] | 462.094 [460.047, 464.973] | 2620.731 [2525.340, 2826.078] | — | — | 1.000 [1.000, 1.000] |
| random | 500 | packedparallel | 1657.270 [1539.992, 1715.524] | 415.469 [415.128, 416.829] | 2659.678 [2574.418, 2677.595] | — | — | 63.000 [63.000, 63.000] |
| random | 500 | packedplain | 5281.969 [5274.346, 8709.433] | 424.171 [418.245, 426.820] | 2602.165 [2428.269, 2850.616] | — | — | 1.000 [1.000, 1.000] |
| source | 50 | baseline | — | — | — | — | 234.500 [217.000, 277.000] | 16.000 [15.000, 17.000] |
| source | 50 | packedgzip | 182.421 [137.420, 240.682] | 51.599 [51.407, 52.484] | 707.742 [686.008, 754.456] | — | — | 1.000 [1.000, 1.000] |

## Warm Git service

This separate experiment used a server and client on two Sprites over HTTPS. It measured API file reads and complete snapshot transfer with client verification. Its timings exclude Firecracker boot, guest apply and ext4 writes. Fill used local canonical fixture storage and warmed server Git files and memory before reads. The current API already caches small blob bytes in SQLite, and this service has no paired current-API control.

| MiB | First 4 KiB read ms | 32-read API p50 / p95 ms | Full snapshot ms, median [min, max] | Local fill seconds |
| --- | --- | --- | --- | --- |
| 50 | 55.755 | 44.243 / 55.755 | 666.649 [603.949, 673.837] | 3.294 |
| 500 | 54.392 | 43.608 / 46.818 | 1557.382 [1507.016, 1612.374] | 37.809 |

Snapshot first-entry timing refers to `assets/a0000.bin`. The separately measured 4 KiB API read used `src/d000/f00000.ts`. A later fill-only compression experiment reduced the 499 MiB Git fill from 38.790 to 24.491 seconds with `core.compression=0`. Default compression ran first, so source cache warming can affect that comparison. Original transfer trials used default compression.

[Warm service evidence and limitations](warm-repo-service/results.md) · [Warm client raw trials](warm-repo-service/raw/shard-2/client-50.jsonl) · [Warm cleanup receipt](warm-repo-service/raw/cleanup.json) · [Git compression follow-up](warm-repo-service/raw/compression/summary.json)

## Provenance and completion

- `20261117T153951Z-f8831868` — [summary](raw/20261117T153951Z-f8831868/summary.json), [archived trial logs](raw/20261117T153951Z-f8831868/host-logs.tar.gz), [restored host](raw/20261117T153951Z-f8831868/restored.json), [locator cleanup](raw/20261117T153951Z-f8831868/ddb-cleanup.log), [S3 cleanup](raw/20261117T153951Z-f8831868/s3-cleanup.log), [console](raw/20261117T153951Z-f8831868/console.log).
- `20261117T155154Z-49671f85` — [summary](raw/20261117T155154Z-49671f85/summary.json), [archived trial logs](raw/20261117T155154Z-49671f85/host-logs.tar.gz), [restored host](raw/20261117T155154Z-49671f85/restored.json), [locator cleanup](raw/20261117T155154Z-49671f85/ddb-cleanup.log), [S3 cleanup](raw/20261117T155154Z-49671f85/s3-cleanup.log), [console](raw/20261117T155154Z-49671f85/console.log).
- `20261117T154851Z-1a566035` — [summary](raw/20261117T154851Z-1a566035/summary.json), [archived trial logs](raw/20261117T154851Z-1a566035/host-logs.tar.gz), [restored host](raw/20261117T154851Z-1a566035/restored.json), [locator cleanup](raw/20261117T154851Z-1a566035/ddb-cleanup.log), [S3 cleanup](raw/20261117T154851Z-1a566035/s3-cleanup.log), [console](raw/20261117T154851Z-1a566035/console.log).
- `20261117T160805Z-21f994ca` — [summary](raw/20261117T160805Z-21f994ca/summary.json), [archived trial logs](raw/20261117T160805Z-21f994ca/host-logs.tar.gz), [restored host](raw/20261117T160805Z-21f994ca/restored.json), [locator cleanup](raw/20261117T160805Z-21f994ca/ddb-cleanup.log), [S3 cleanup](raw/20261117T160805Z-21f994ca/s3-cleanup.log), [console](raw/20261117T160805Z-21f994ca/console.log).

The first series completed all 12 trial tests and 36 phase checks before the outer maintenance wrapper hit a shell parser error. Host restoration and scoped cleanup completed, and the archived logs and all first-read measurements were independently reviewed. The aggregation rechecks terminal PASS markers, phase counts, reported measurements, binary revisions and restoration/cleanup receipts. The wrapper error remains recorded in its console log.

Prepared manifests were supplied by the trusted fixture. Production publication, retry, retention and deletion integration would require additional implementation.

The final pilot check records the original service active, its binary checksum correct, both slots free, no allocated VMs, and no benchmark VM scopes, taps or mounts. All four owned remote qualification folders were removed after their evidence and cleanup receipts were captured.

[Final host state](final-host.json) · [Final service and cleanup check](final-pilot-check.log) · [Independent data review](independent-review.json)

[Machine-readable results](results.json) · [Per-phase CSV](phases.csv) · [Input checksums](raw-manifest.json) · [Aggregation script](aggregate.py)
