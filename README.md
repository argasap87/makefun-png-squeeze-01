# makefun-png-squeeze-01

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/argasap87/makefun-png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/argasap87/makefun-png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Squeeze 1280×720 screenshots into the smallest lossless PNG — a make.fun bounty entry.

**The approach:** screen the exact colour-type forms (palette by count / by luminance, grey, grey+alpha, RGB, RGBA, with a tRNS key when one fully-transparent value exists) and the per-row filter choices (fixed 0–4, minsum, pairs, brute force) with zlib, then write the winner with a from-scratch optimal-parse deflate: hash-chain lazy match finding, dynamic-programming parse over (length, distance) candidates under a bit-cost model, length-limited Huffman via a heap build, and per-block dynamic Huffman tables. A cheap first DP pass (shallow chains, range-start lengths only) builds the cost model; the full pass offers every length for short matches and range starts for long ones. The DP is also run on the brute-force filter when the zlib winner's own DP gain is small and the brute filter is plausible under zlib — the DP often prefers it. zlib level 9 is kept as a fallback whenever it is smaller. Fully deterministic: no clock, no randomness, no environment-dependent choices; the whole 8-image set fits the 60 s wall.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/image.png` (or `$MAKEFUN_INPUT_DIR`), writes `/output/<id>/image.png` (or `$MAKEFUN_OUTPUT_DIR`). Node 22+, built-ins only, no network.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
