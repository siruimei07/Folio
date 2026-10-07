# Frozen format fixtures

Files that a released Folio wrote, kept byte for byte so that every later Folio can be tested
against them (ADR-0002 action item 5, testing strategy "Core integration"). Never regenerate or
edit them: a fixture that changes proves nothing.

## v0.1 (M1)

Written on 2026-10-03 by the code of `origin/main` `27b3cda` (gate `gate/m1-acceptance`), through
the same calls the app makes: `library::state::create` with the first run's English preset tags,
then a scan, hashing, and `update_course`, `update_semester`, `create_course`, `create_folder`,
`create_tag` and `set_entry_tags` on the catalog.

| Path | What | Version |
|---|---|---|
| `v0.1/library/` | A library folder: user files and `.folio/` (`library.json`, `tags.json`, `ignore`, `meta/_root.json`, `meta/<semester>/_group.json`, `meta/<semester>/<course>.json`, including the escaped `__杂项.json`) | metadata `format_version` 2 |
| `v0.1/catalog.sqlite` | That library's catalog after its scans, hashing and tagging; checkpointed, without its WAL | schema (`user_version`) 2, tokenizer 2, paths 1 |
| `v0.1/journals/scan.json` | The scan journal of a rename, copied the moment before Windows renamed the file: what a crash there leaves | journal `format_version` 3 |
| `v0.1/journals/import.json` | An import intent, left by a replace that crashed after publishing the intent and before recycling the old file | intent `format_version` 1 |
| `v0.1/app-data/settings.json` | This computer's settings (not synced) | settings `format_version` 1 |

The library id is `48ffdfb335860f2c15c8bccf2a90e720`; the custom tag "Lab reports" is
`88a8ea5c2a25ea7f`. Two files are there for the library's ignore rules (`*.tmp`, `scratch/`;
not `*.log` or `build/`, which the repository's own `.gitignore` would keep out), and two folders
made in Folio hold a file each, because Git keeps no empty folders.

`../format_fixtures.rs` opens each one with the current code. Copies go to temporary folders, so
the tests never write here.

## When a format changes

1. Bump its version and write the migration (catalog: a new step in `catalog/schema.rs`; JSON: a
   reader that accepts the old version, ADR-0002 §3).
2. Keep every test on `v0.1/` passing: older files must still open.
3. Add a folder for the release that introduces the new version (for example `v0.2/`), written
   by that release's code, and point `v0_1_metadata_bytes_are_what_this_folio_writes` (or its
   successor) at it.
4. Record the frozen versions in ADR-0002 §3.
