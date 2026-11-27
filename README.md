[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/argasap87/makefun-png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/argasap87/makefun-png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

# png-squeeze-01-run-20261127

A lossless PNG squeezer for the make.fun `png-squeeze-01-run-20261127`
bounty: it reads each 1280×720 RGBA screenshot from `/input/<id>/image.png`
and writes the same pixels back as the smallest PNG it can, in
`/output/<id>/image.png`.

## How it works

`main.ts` (Node 22, built-ins only, deterministic, no network, no clock) does
three things per image:

1. **Exact forms.** It analyses the pixels and tries the lossless forms the
   format allows: a palette (colour type 3, entries ordered by count) when the
   image has at most 256 colours, grey (type 0) or grey+alpha (type 4) when
   every pixel is grey, RGB (type 2) or RGBA (type 6) otherwise, plus a tRNS
   key when a single fully-transparent value is the only non-opaque colour.
2. **Filter screening.** For each form it builds the filtered data under
   several per-row filter choices (all-None, all-Paeth, fewest-distinct-pairs)
   and keeps the smallest by zlib level 6.
3. **Optimal-parse deflate.** The winner is compressed by a from-scratch
   zopfli-style deflate: a hash-chain LZ77 search feeding a forward dynamic
   programming parse (Pareto-optimal length/distance candidates, chain depth
   adapted to the data size), with Huffman code lengths from package-merge,
   seeded by the symbol frequencies of a fast greedy parse. The stream is
   emitted as dynamic deflate blocks (8,192 symbols each) and the smaller of
   it and zlib level 9 wins. Every step is deterministic: the same input
   always produces byte-identical output.

## Run locally

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT. See [LICENSE](LICENSE).
