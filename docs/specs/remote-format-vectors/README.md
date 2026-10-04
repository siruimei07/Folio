# Golden vectors of the history format

Byte-exact test data for [remote-format.md](../remote-format.md), in a form any language can read:
JSON files whose bytes are lowercase hex. Section 12 of the spec describes each file and the
example library they are built from.

| Folder or file | What |
|---|---|
| `v1/` | The vectors of format version 1. Never edited once v0.2 ships (`records.json` once v0.3 ships): a later version adds `v2/`, and its readers must still pass `v1/` |
| `generate.mjs` | Writes `v1/`: a second implementation of the format in JavaScript, independent of `folio-core`, whose own reader confirms every outcome. Its zstd frames are kept as data, so the output does not depend on a compressor's version |

```bash
node docs/specs/remote-format-vectors/generate.mjs --check
```

`pnpm check` runs this command (`check:vectors`). It confirms that `v1/` is what the generator
writes, and needs Node 24 and nothing else. Without `--check` the generator rewrites the folder,
which is only right while version 1 is unreleased.

`folio-core` reads every file in its tests (`feat/core-object-store`). A vector's `reason` is
informative: an implementation must reach the same outcome (valid, `newer`, `missing` or invalid),
not the same words.
