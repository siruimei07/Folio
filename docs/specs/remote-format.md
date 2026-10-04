# History format (version 1)

The normative, language-neutral definition of how Folio stores history: the objects that hold it,
the packs that hold the objects, and the files of the remote history store in iCloud Drive. The
local store (`.folio/local/`, [versioning.md](versioning.md) §4) and the remote store (§10) hold
the same objects, so a commit made on one device reaches the others byte for byte.

- Status: approved by Sirui on 2026-10-03 (decision `remote-format`), after its code review; lane
  `docs/specs-history-format`. ADR-0003 action item 2.
- Inputs: [ADR-0003](../adr/ADR-0003-versioning-and-sync.md) §2–§6, §13;
  [ADR-0002](../adr/ADR-0002-data-storage.md) §2–§3; [ADR-0006](../adr/ADR-0006-history-retention.md);
  [library-core.md](library-core.md) §3–§4; [brief](../product/brief.md) §4, §5.4–§5.6.
- Golden vectors: [`remote-format-vectors/v1/`](remote-format-vectors/v1/) (§12).
- §14 lists where this spec refines ADR-0003.

## 1. Scope

| Part | Sections | Frozen |
|---|---|---|
| A. Objects and packs | §3–§9, §11 | When v0.2 ships: v0.2 writes them into every library's local store, and M3 pushes those commits unchanged |
| B. The remote store: layout, `FORMAT.json`, head records, intents, deleting packs | §10 | When v0.3 ships. No remote store exists before then, so `docs/specs/sync.md` (lane `docs/specs-sync`, after the iCloud field test) may still change Part B and its vectors (`records.json`) without a new version, with Sirui's approval |

Not in this spec: the sync protocol (choosing the canonical head, one sync round, the mirror rules;
ADR-0003 §6–§9, then sync.md), the local store's own files (`HEAD`, the operation log, journals;
versioning.md §4) and the metadata files (library-core.md §4).

**Must**, **must not** and **may** are normative. A *writer* creates files of the format, a
*reader* reads them. Everything a reader takes from the remote is untrusted input (ADR-0003 §7).

## 2. Notation

- Bytes are written in lowercase hexadecimal, two digits per byte.
- Fixed-width integers are unsigned and little-endian: `u8`, `u32`, `u64`.
- Text is UTF-8 without a byte order mark. A *character* is a Unicode scalar value.
- *UTF-8 byte order* compares the UTF-8 encodings byte by byte (`memcmp`); it equals code point
  order.
- *White space* is the Unicode `White_Space` property (Rust `char::is_whitespace`). *Control
  characters* are general category `Cc`: U+0000–U+001F and U+007F–U+009F.

## 3. Versions and compatibility

**A version per part.** Four parts of the format have versions of their own, each now 1:

| Part | Where its version is |
|---|---|
| Packs and the objects in them | The pack header (§9.1) |
| `FORMAT.json` | Its `format_version` (§10.2) |
| Head records | Their `format_version` (§10.3) |
| Intents | Their `format_version` (§10.4) |

A change to one part never changes another's version. Blobs, trees and commits carry no version:
the pack that holds them states it.

**Old data stays readable forever.** A reader reads every version of a part up to its own.
Objects are never rewritten, so a version 1 object keeps its id and stays valid for every later
Folio.

**Strict within a version.** A reader checks every rule of the version a file states. An unknown
field, kind, operation, record type or flag, or a value outside its rule, makes the file
*invalid*: nothing is skipped as "probably newer". Every change to a part, an optional field
included, therefore raises its version (the rule library-core.md §4.3 sets for metadata files).

**The version comes first.** A reader reads a file's version before applying any other rule: the
pack header's, or the `format_version` member of a record's JSON object. A record that is not a
JSON object with a positive integer `format_version` is invalid; one that states a higher version
than the reader knows is *newer*, whatever else it holds.

**Newer data is not interpreted.**

- A newer pack: its objects are not available to this reader. When the library's history needs
  them (a library last used by a newer Folio), Folio makes the history read-only (no commit,
  reword, uncommit or restore) and asks for an update; the library itself stays usable.
- A newer `FORMAT.json`, head record or intent: the device makes the remote read-only (no push) and
  asks for an update (ADR-0003 §13); sync.md says how far it can still read.

**Writers write the lowest version whose rules a file meets**, which is 1 until a later version
adds something a file needs. A device that is not updated yet then keeps reading everything that
does not use the new feature.

**How the format may grow.** A later version may add record types, object kinds, fields and remote
files. It must not change what a valid version 1 byte string means. A change to how an existing kind
is encoded or hashed needs a new kind with a new derive_key context (`folio tree v2`).

**Not part of the format.** Writers may change these freely: compression choices, the order of
records in a pack, which pack holds which object, pack sizes (§9.5), and which files a library
ignores.

## 4. Content hash and object ids

BLAKE3 with 32-byte output, in two of its modes:

| Object | Content | Id |
|---|---|---|
| Blob | The raw bytes of one stored file version | BLAKE3 hash of the bytes: the file's *content hash* |
| Tree | Canonical JSON (§7.2) | BLAKE3 `derive_key` with context `folio tree v1` over the bytes |
| Commit | Canonical JSON (§7.3) | BLAKE3 `derive_key` with context `folio commit v1` over the bytes |

- The contexts are the ASCII strings shown, exactly. They separate the three kinds: the same bytes
  as a blob, a tree and a commit have three different ids (vector `hashes.json`,
  `domain_separation`). BLAKE3 asks for globally unique contexts when deriving keys; here they only
  separate kinds, so a clash with another application's context would do no harm.
- **Text form:** `b3:` and 64 lowercase hexadecimal digits, for every object id and content hash
  (catalog, trees, commits, records). **Binary form** (packs): the 32 bytes.
- The content hash of every file, stored or not, is the BLAKE3 hash of its bytes, the same value the
  catalog keeps (ADR-0002 §4) and the mirror is verified against.
- An id covers the exact bytes. Verifying an object recomputes the id from the bytes read (§11),
  never from a value encoded again.

## 5. Canonical JSON

Trees, commits and the records of §10 are canonical JSON: each value has exactly one encoding. It is
the subset of RFC 8259 JSON below, and for every value the format allows it equals RFC 8785 (JCS).

1. **Text.** UTF-8, no byte order mark, no white space outside strings, no final line break.
2. **Values.** Objects, arrays, strings, `true`, `false`, and integers from 0 to 2^53 − 1
   (9,007,199,254,740,991) in decimal without a sign or leading zeros. There is no `null`: a value
   that is absent is left out. No fractions, exponents, negative numbers or `-0`.
3. **Objects.** Keys are distinct. Members are in ascending UTF-8 byte order of their keys. Every
   key in the format is ASCII, where this is also JCS's order.
4. **Arrays** keep their order; the schemas say where an order is required.
5. **Strings** are valid Unicode (no lone surrogates) and escape exactly these characters:
   `"` as `\"`, `\` as `\\`, U+0008 `\b`, U+0009 `\t`, U+000A `\n`, U+000C `\f`, U+000D `\r`, and
   the other characters U+0000–U+001F as `\u00` and two lowercase hexadecimal digits. Every other
   character is written as itself: `/`, U+007F, U+2028, U+2029 and all non-ASCII text included.
6. **Depth.** Objects and arrays nest at most 16 levels, the document's own object being level 1.

A reader parses a document, checks the value rules, encodes the value again and compares the bytes.
A document whose bytes differ is invalid even when its value is fine; so is one with a duplicate
key or one nested too deeply. Vectors: `canonical-json.json`.

## 6. Values

### 6.1 Ids

- **Object ids and content hashes:** §4.
- **Library id and device id:** 32 lowercase hexadecimal digits (128 random bits). The library id is
  the `id` of `.folio/library.json`; the device id is generated once per Windows installation
  ([versioning.md](versioning.md) §4.6).

### 6.2 Times

Exactly `YYYY-MM-DDTHH:MM:SSZ`: UTC, whole seconds, upper-case `T` and `Z` (a profile of RFC 3339).
It must be a real Gregorian date and time from `1970-01-01T00:00:00Z` to `9999-12-31T23:59:59Z`,
with seconds 00–59. Clocks may be wrong, so readers never take the order of commits from their
times: `parent` gives it.

### 6.3 Sizes and counts

Sizes are integers from 0 to 2^53 − 1 (§5). Counts (`seq`, `lamport`) are at least 1.

### 6.4 Names

A name is one entry of a tree, or one segment of a path. These are the rules `paths::check_name`
applies at `PATHS_VERSION` 1 (library-core.md §3), frozen here: a later change to `check_name` does
not change them.

1. Not empty.
2. Not `.` or `..`.
3. No U+0000–U+001F and none of `< > : " / \ | ? *`.
4. Does not end with `.` or a space.
5. Not a Windows device name: take the part before the first `.` and remove the spaces at its end.
   It must not equal, ignoring ASCII case, `CON`, `PRN`, `AUX`, `NUL`, `CONIN$` or `CONOUT$`, nor
   be `COM` or `LPT` followed by exactly one of `0`–`9`, `¹`, `²`, `³` (`nul.txt` and `CON .txt`
   are device names; `COM10` and `CONSOLE` are not).
6. At most 255 UTF-16 code units.
7. In Unicode Normalization Form C. Unicode's normalization stability policy keeps a name that is
   NFC under one Unicode version NFC under every later one, so a reader with newer tables accepts
   what a writer with older ones wrote. (A name that holds a character the writer's tables do not
   know yet could still fail with newer tables; Folio writes only names its scan accepted, which
   rules such names out in practice.)

Names are compared as byte strings. Two names that differ only in case are different names: case
twins are valid in the format. Folio reports them (library-scan.md §4), and sync.md decides what the
mirror does with them, since Windows and Apple file systems ignore case.

### 6.5 Paths

Names (§6.4) joined by `/`, relative to the library root: no empty name, so no leading, trailing
or doubled `/`, and at most 32,767 UTF-16 code units in all.

### 6.6 Display names

A device name: 1–128 characters, no control characters, not starting or ending with white space
(library-core.md §4.2).

### 6.7 Messages

- **Summary:** 1–256 characters, no control characters (so one line), not starting or ending with
  white space.
- **Body:** 1–16,384 characters; no control characters except tab (U+0009) and line feed (U+000A);
  not starting with a line feed; not ending with white space. A message without details leaves the
  body out instead of writing it empty.

Vectors for §6: `values.json`.

## 7. Objects

### 7.1 Blob

The raw bytes of one stored file version, of any length. Its id is its content hash (§4).

### 7.2 Tree

One folder. The course folder of the example library (§12), as it is first committed:

```json
{"entries":[
  {"hash":"b3:…","kind":"dir","name":"Lectures"},
  {"hash":"b3:9b8b2fc76f6386c5507b9f545e0c960472b47ae5c4a4a906b952377ff33460d3","kind":"dir","name":"Projects"},
  {"hash":"b3:…","kind":"dir","name":"作业"},
  {"hash":"b3:a3d7ca49ab4001410f429b31e14381e3dadac9a987ac85f1f73995464ac6913c","kind":"file","name":"报告.docx","size":1024,"stored":true},
  {"hash":"b3:fbbd743f87fd3e63897682fa5d92352c5d9989d42c5c9261f1a5110e9efead66","kind":"file","name":"第3讲 特征值.md","size":39,"stored":true}
]}
```

(Line breaks added and two ids shortened here; the object's bytes have neither. `Projects` is an
empty folder.)

| Field | Value |
|---|---|
| `entries` | The folder's entries in strictly ascending UTF-8 byte order of `name`, so names are distinct |
| File entry | `hash`: the content hash; `kind`: `"file"`; `name` (§6.4); `size`: bytes; `stored` |
| Folder entry | `hash`: the tree id of the folder; `kind`: `"dir"`; `name` |

- No other fields. A folder entry has no `size` or `stored`.
- An empty folder is the tree `{"entries":[]}` (its id: `hashes.json`, `derive_key`, `empty-tree`).
- **`stored`** is true exactly when the library's versioning rules in the same commit (its
  `.folio/library.json`) keep versions of the file, by its extension and size (versioning.md §5.1),
  and for every file under `.folio/` (§7.4). So equal content under equal rules gives equal trees,
  whatever the history before. A writer puts the blob of every stored entry in the store (§7.5 says
  how a blob that was thinned out comes back). Readers do not check the flag against the rules.
- A tree's canonical JSON is at most 64 MiB, and so is a commit's.

### 7.3 Commit

| Field | Kinds | Value |
|---|---|---|
| `tree` | all | Id of the root tree |
| `parent` | all; required for `prune` | The previous commit's id. Left out only on a library's first commit |
| `device` | all | `{"id": device id, "name": display name}`: the device that made the commit (§6.1, §6.6) |
| `time` | all | When the commit was made (§6.2) |
| `kind` | all | `commit`: made on a device; `import`: direct edits found in the remote (ADR-0003 §7), shown as from iCloud; `prune`: thinning (§7.5) |
| `summary` | `commit`, `import` | §6.7 |
| `body` | `commit`, `import`; optional | §6.7 |
| `changes` | `commit`, `import`; optional (§8) | The change records |
| `rebased_from` | all; optional | The id of the commit this one was rebased from (ADR-0003 §6) |
| `pruned` | `prune` | The thinned blobs (§7.5) |

- No other fields.
- A `commit` or `import` changes its tree: its tree id differs from its parent's. There are no
  empty commits; a rebase drops commits that become empty (ADR-0003 §6).
- The second commit of the example library, with line breaks added and `changes` shortened:

```json
{"changes":[
   {"kind":"file","new":{"hash":"b3:…","size":232,"stored":true},
    "old":{"hash":"b3:…","size":239,"stored":true},"op":"modify","path":".folio/meta/2026 秋/线性代数.json"},
   {"from":"2026 秋/线性代数/作业/hw2.pdf","kind":"file",
    "new":{"hash":"b3:cfe8…","size":2048,"stored":false},
    "old":{"hash":"b3:cfe8…","size":2048,"stored":false},"op":"move","path":"2026 秋/线性代数/hw2.pdf"},
   {"kind":"dir","op":"delete","path":"2026 秋/线性代数/作业"},
   …
   {"from":"2026 秋/线性代数/Lectures","kind":"dir","op":"move","path":"2026 秋/线性代数/讲义"},
   {"from":"2026 秋/线性代数/Lectures/L2.md","kind":"file",
    "new":{"hash":"b3:…","size":27,"stored":true},
    "old":{"hash":"b3:…","size":12,"stored":true},"op":"move","path":"2026 秋/线性代数/讲义/L2.md"},
   …],
 "device":{"id":"8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c","name":"G16"},
 "kind":"commit",
 "parent":"b3:…",
 "summary":"MAT232: update 3 files, move 2 items; Library: delete 1 file",
 "time":"2026-10-03T23:30:00Z",
 "tree":"b3:…"}
```

The folder `Lectures` became `讲义`: one record covers it and `L1.md`, which moved along unchanged;
`L2.md` was edited too, so it has a record of its own (§8 rule 3).

### 7.4 The library's metadata and Folio's private folders

Every commit's root tree holds the library's synced metadata files (ADR-0002 §2) under `.folio/`,
and nothing of Folio's private folders. Names are compared here as NTFS compares them: ignoring
ASCII case, with `ı` (U+0131) counting as `i` and `ſ` (U+017F) as `s`, which is what Unicode's
simple uppercase mapping does for these names (`meta::is_folio_owned`).

1. The root has an entry named exactly `.folio`, a folder. No other root entry compares equal to
   `.folio` (`.Folio`, `.folıo` are invalid).
2. `.folio` holds the file `library.json`. The only folder it may hold is `meta`, and it holds no
   entry that compares equal to `local` (the device's store, ADR-0003 §4) or `store` (the remote's
   history area, §10). It may hold other files (`tags.json`, `ignore`, and files a later metadata
   format adds).
3. `.folio/meta` holds files and folders, and each of those folders holds only files.
4. Every file under `.folio/` has `stored: true`.
5. Every path of the tree is at most 32,767 UTF-16 code units (§6.5).

Folders are where private data would go, so a tree can add metadata files without a new format
version but no folder Folio might one day keep for itself. Ignored files (library-scan.md §5) are
never in a tree Folio writes, but that is writer policy: the ignore rules change with Folio's
defaults and with `.gitignore` files, so readers do not check it. Vectors: `commit-rules.json`,
`root`.

**Names on a disk are not names in a tree.** Windows may give a folder a second, short 8.3 name
(`FOLIO~1` for `.folio` on a volume with short names, as C: has by default) and resolves paths
through it. A tree may hold a folder named `FOLIO~1`, valid by every rule above, so these rules
protect Folio's folders by name only: whoever writes a tree's paths to a disk (sync's pull and
mirror, restore) checks that every existing folder or file it writes through or replaces has exactly
the name the tree gives, and refuses otherwise (§11).

### 7.5 Thinning: prune commits

Sirui chose to thin out old Word versions over time ([ADR-0006](../adr/ADR-0006-history-retention.md)).
Commits and trees are never removed; only blobs are, and a prune commit records which:

```json
{"device":{"id":"8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c","name":"G16"},"kind":"prune","parent":"b3:…","pruned":["b3:a3d7ca49ab4001410f429b31e14381e3dadac9a987ac85f1f73995464ac6913c"],"time":"2026-12-10T03:00:00Z","tree":"b3:…"}
```

- `tree` equals the parent's tree. `pruned` lists 1–100,000 blob ids in strictly ascending order,
  none of them the content of a stored file entry of the commit's own tree: a current version is
  never thinned out.
- A prune commit has no `summary`, `body` or `changes`; the UI words it from its kind and count.
- **Meaning.** A prune commit thins out the versions of the commits before it whose blobs it lists.
  A later commit that stores the same content brings it back: its writer puts the blob in its own
  pack again (a writer treats every blob that a prune commit of its history lists as absent from
  the store), and stores keep it.
- **Pruned or missing.** A stored entry of a commit C whose blob is absent is *pruned* when a
  prune commit after C, up to the head, lists the blob, and shows without a diff or a restore.
  Otherwise it is *missing*: pending on the remote, damage in the local store (§11).
- **Deleting.** A store may delete a blob only when every commit up to the head that stores it is
  followed by a prune commit that lists it.
- Which blobs to thin out is policy (ADR-0006, versioning.md §5.4), not format. Readers do not check
  it. Vectors: `commit-rules.json`, `availability` and `deletion`.

## 8. Change records

`changes` says how a commit's tree differs from its parent's: the history view lists files without
walking trees, and moves are recorded, which trees alone cannot show.

**Flattened trees.** Flatten a tree into every path it holds with its entry: a folder as
`{kind: dir}`, a file as `{kind: file, hash, size, stored}`. Two entries are the *same* when both
are folders, or both are files with equal `hash`, `size` and `stored`. Let P be the parent's
flattened tree (empty for a first commit) and T the commit's.

- *From-side paths*: paths of P whose entry is not the same in T (absent from T, or different).
- *To-side paths*: paths of T whose entry is not the same in P.

| `op` | `kind` | Fields besides `op`, `kind` | From side | To side |
|---|---|---|---|---|
| `add` | `file` | `path`, `new` | — | `path` |
| `add` | `dir` | `path` | — | `path` |
| `delete` | `file` | `path`, `old` | `path` | — |
| `delete` | `dir` | `path` | `path` | — |
| `modify` | `file` | `path`, `old`, `new` | `path` | `path` |
| `move` | `file` | `from`, `path`, `old`, `new` | `from` | `path` |
| `move` | `dir` | `from`, `path` | `from` | `path` |

Rules:

1. `old` and `new` are `{"hash", "size", "stored"}` and equal P's entry at the record's from-side
   path and T's entry at its to-side path. A record's `kind` equals those entries' kinds.
2. **Coverage.** Every from-side path is covered exactly once, and every to-side path exactly once:
   by a record's from side or to side, or by a folder move (rule 3). Nothing else is covered.
3. **A folder move carries what moved with it.** A `move` of a folder from F to G also covers each
   path F/r of P together with G/r of T when their entries are the same. Those paths have no
   records; every other changed path below F or G has its own (a file edited inside the moved folder
   is a `move` whose sides differ).
4. `modify`: `old` differs from `new`. `move`: `from` differs from `path`; `old` may equal `new`.
5. **Order.** Ascending by `path` (UTF-8 byte order), then `delete`, `add`, `modify`, `move`. A
   `(path, op)` pair occurs once.
6. **Moves are claims of identity** that the writer knows (Folio pairs entries by NTFS file id,
   library-scan.md §6.1). A writer may write any move as a `delete` and an `add`, at one path too
   (a swap of two names); readers accept both. Folio writes an in-place change as `modify` and a
   folder rename as one folder `move`. A move whose old path holds the same entry again in T (a
   folder renamed and a folder of the old name created, or a file moved and an identical copy left
   behind) has no from side to cover: the writer records its new path as an `add` and, for a folder,
   records each path below it by these rules again.
7. **Optional.** A commit may leave `changes` out; when present it holds 1–100,000 records and is
   complete. Without it, readers compare the two trees themselves and find no moves. Folio writes it
   whenever it fits.

A reader checks `changes` against P and T when it first reads a commit; a commit that fails is
invalid. It need not flatten whole trees: walking both trees and skipping folders whose tree ids
are equal finds the same paths, and a folder move between two folders with equal ids covers its
whole subtree. Vectors: the commits of `objects.json`, and `commit-rules.json`, `commits` and
`changes`.

## 9. Packs

Objects are stored only in packs, never one file per object (ADR-0003 §3).

### 9.1 Layout

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | Magic `FOLIOPK1` (`46 4f 4c 49 4f 50 4b 31`) |
| 8 | 4 | `u32` format version: 1 |
| 12 | … | Records (§9.2), back to back |
| I | 40 × N | Index entries (§9.4), where I = L − 48 − 40 × N |
| L − 48 | 8 | `u64` N: the number of index entries, at least 1 |
| L − 40 | 8 | End magic `FOLIOEND` (`46 4f 4c 49 4f 45 4e 44`) |
| L − 32 | 32 | BLAKE3 hash of bytes 0 to L − 33: everything before it |

L is the file's length. The smallest pack, one empty blob, is 150 bytes.

### 9.2 Records

| Size | Field |
|---|---|
| 1 | `u8` type: 1 blob, 2 tree, 3 commit |
| 1 | `u8` flags: bit 0 set means the payload is zstd (§9.3); the other bits are 0 |
| 32 | Object id (§4) |
| 8 | `u64` raw length: the object's length |
| 8 | `u64` stored length: the payload's length |
| stored length | Payload: the object, or its zstd frame |

- Uncompressed, the stored length equals the raw length.
- Records cover the bytes from 12 to I exactly, with nothing between them.
- A tree or commit has a raw length of at most 64 MiB, read from its record before its payload.
- An id occurs at most once in a pack. The same object may be in several packs.

### 9.3 Compression

When bit 0 is set, the payload is exactly one zstd frame (RFC 8878), with no skippable frame and
nothing after it, which decodes to exactly the raw length. The frame has:

- no dictionary (`Dictionary_ID` absent or 0);
- a `Window_Size` of at most 8 MiB (2^23 bytes), the size RFC 8878 asks every decoder to support;
  in a single-segment frame the window is the content size;
- a `Frame_Content_Size`, if it has one, equal to the raw length.

A content checksum is optional, and checked when present. Compressed bytes are not canonical: a
writer need not reproduce another writer's frames, and the pack vectors hold frames that a reader
must decode.

### 9.4 Index, trailer and name

- Index entries are the object id (32 bytes) and the `u64` offset of its record, in strictly
  ascending order of the id's bytes, one per record. They end where the trailer begins.
- The pack's file name is the trailer's hash in lowercase hexadecimal followed by `.pack`. A pack
  thereby verifies itself, and two packs with the same name hold the same bytes.

### 9.5 Writing (guidance, not format)

- Any record order is valid. Folio writes blobs, then trees from the deepest folder up, then
  commits oldest first.
- Folio compresses text blobs, trees and commits with zstd level 3, and stores Word blobs raw
  (`.docx` is already compressed); a payload that compression does not shrink is stored raw.
- An object already in the store is not written again, except a blob that a prune commit lists
  (§7.5).
- A Word blob of at least 1 MiB gets a pack of its own, so that thinning can delete a whole pack
  instead of rewriting one (ADR-0006). Other packs stay under 1 GiB.
- A writer streams large blobs: it knows the raw length from the file, the id from the hash the
  catalog already holds and the stored length after compressing, which it does in memory for text
  bounded by the size limit. If the bytes read do not match the expected hash, it truncates the
  staging file back to that record and writes it again or leaves it out. The pack's hash is
  computed in the same pass. It writes in a staging folder, flushes, and publishes with one rename.
- A push publishes only objects reachable from the head it pushes. It may publish a local pack as
  it is when every object in it is reachable; otherwise it writes a new pack. Objects a device
  keeps that no pushed commit reaches (an uncommitted or reworded commit, a blob only it stored)
  never leave the device.

## 10. The remote store

**Part B: provisional until v0.3** (§1). Layout and rules from ADR-0003 §5, record fields from
ADR-0003 §5–§6.

### 10.1 Layout and rules

```text
<remote>/                                   a folder in iCloud Drive
  2026 秋/线性代数/第3讲 特征值.md          the mirror: the canonical commit's tree as plain files
  .folio/library.json, tags.json, ignore, meta/…   the tree's .folio/ entries, mirrored
  .folio/store/                             the history area (not part of any tree, §7.4)
    FORMAT.json                             §10.2
    packs/<64 hex digits>.pack              §9
    intents/<device id>/<seq>.json          §10.4
    heads/<device id>/<seq>.json            §10.3
```

- `seq` is a decimal number without leading zeros, starting at 1 for each device. A device's intents
  and heads share one counter; its next number is one more than the largest it finds in its own
  folders and its own records, so a restored backup never reuses a written path.
- A file whose name does not match the patterns above is not Folio's (`42 2.json`, an iCloud conflict
  copy; `.DS_Store`): readers ignore it and report it. So is a record whose content names another
  device or number than its path (§10.3).
- **Write once.** A file is written once and never modified or renamed in place.
- **Device-owned.** A device writes intents and heads only under its own id. Packs are named by
  their content, so two writers of one name write the same bytes.
- **One rename.** A file is written in a staging folder outside the sync root on the same NTFS
  volume, flushed, and moved into place with one rename (ADR-0003 §5). The remote and the library
  may be on different volumes, so this staging folder is the remote volume's, not the library's.
- **Safe names.** No zero-byte files, and no names that iCloud skips (`.tmp`, `.nosync`, `~$…`).
- **Pinned.** Folio keeps `.folio/store/` downloaded (ADR-0003 §12).
- **Deleting packs** (ADR-0006 changes ADR-0003's "no remote garbage collection"). Only packs are
  ever deleted, and only a pack each of whose objects either may be deleted (§7.5) or is in another
  pack. The deleting device waits at least 30 days, by its own clock, after it first saw the prune
  commit that allows the deletion and the other pack, never trusting the times written in them, and
  deletes through the Recycle Bin, so iCloud keeps the pack another 30 days. sync.md specifies the
  procedure; until it does, no Folio deletes anything in `.folio/store/`.

### 10.2 `FORMAT.json`

```json
{"format_version":1,"library_id":"48ffdfb335860f2c15c8bccf2a90e720"}
```

Written once, when the remote is created in an empty folder. Its `library_id` must be the local
library's id. At most 4 KiB.

### 10.3 Head records

`heads/<device id>/<seq>.json`, one per push, published last (ADR-0003 §8):

```json
{"device":{"id":"8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c","name":"G16"},"format_version":1,"head":"b3:…","intent":2,"lamport":2,"library_id":"48ffdfb335860f2c15c8bccf2a90e720","packs":[{"name":"<64 hex digits>.pack","size":6251}],"seq":2,"time":"2026-10-04T08:00:00Z"}
```

| Field | Value |
|---|---|
| `format_version` | 1 |
| `library_id` | The library's id |
| `device` | `{"id", "name"}` of the pushing device; `id` is the folder's name |
| `seq` | This record's number, the file's name |
| `lamport` | 1 plus the largest Lamport value the device has seen (ADR-0003 §6) |
| `head` | The commit id this push publishes |
| `intent` | The `seq` of the intent that announced this push's mirror writes; at most `seq` |
| `packs` | The packs this push published, one or more per push: `{"name", "size"}`, the size at least 150 bytes; at most 1,000, ascending by name |
| `time` | When the record was written |

A head is complete when every object reachable from `head` is present in some pack, or pruned
(§7.5), wherever it is; `packs` says what to wait for. At most 1 MiB.

### 10.4 Intents

`intents/<device id>/<seq>.json`, published before the mirror writes it lists (ADR-0003 §8):

| Field | Value |
|---|---|
| `format_version`, `library_id`, `device`, `seq`, `time` | As in a head record |
| `base` | The canonical commit the push builds on; left out when the remote held no history |
| `head` | The commit the push will publish |
| `writes` | The mirror changes, ascending by `path` and then `delete` before `write`: `{"op": "write", "kind": "file", "path", "hash"}`, `{"op": "write", "kind": "dir", "path"}` (the folder will exist), `{"op": "delete", "kind": "file" or "dir", "path"}` |

Every `path` is a path (§6.5) that a tree may hold (§7.4): never inside `.folio/local` or
`.folio/store`, and `.folio` itself is only ever written as a folder, never deleted. At most 64 MiB.
Vectors for §10: `records.json`.

## 11. Reading

**A pack**, in this order: the first step that fails decides the outcome. A reader may combine the
steps into one sequential pass. A remote pack passes every step before any of its objects is used.
A local pack, which this device wrote, passes steps 1–4 and 6 when Folio indexes it (header,
trailer and index), and steps 7–11 for each record it reads; step 5 and the walk over every record
read the whole file, so they run in a full check rather than in every catalog rebuild
(versioning.md §4.3).

1. At least 150 bytes.
2. Magic `FOLIOPK1`.
3. Version: 0 is invalid; above 1 is newer (§3), and the reader stops.
4. End magic `FOLIOEND`.
5. The hash, and the file name when it is known.
6. N at least 1 and the index inside the file after the first record header; index entries in
   strictly ascending order.
7. Records: types, flags, bounds; each record has the index entry with its offset, and the index has
   no other entries.
8. A tree or commit's raw length at most 64 MiB.
9. Payload: the zstd rules (§9.3) and the raw length.
10. The object id (§4).
11. Trees and commits: canonical (§5) and the schema (§7.2, §7.3).

**A record**, in this order: its size cap (§10.2–§10.4) before reading it; JSON; the version (§3);
canonical form; the schema; and that its path names its device and number (§10.1).

**A commit in its history**, when Folio first reads it: its tree, its subtrees and its parent's are
present (otherwise missing, below); the root tree follows §7.4; `changes` follows §8; a prune commit
follows §7.5.

| Outcome | Meaning | Folio does |
|---|---|---|
| Invalid | Damaged, or written by a faulty writer | Never uses it; reports it |
| Newer | Written by a newer Folio | Does not interpret it; read-only, asks for an update (§3) |
| Missing | An object something needs is absent and not pruned | Remote: pending, waits for iCloud. Local: history damaged |
| Pruned | A stored blob thinned out by a prune commit (§7.5) | Shows the version without a diff or a restore |

Paths in trees, change records and intents are checked (§6.4, §6.5, §7.4) before they touch a disk,
and every size is bounded before memory is allocated for it. **Writing to a disk**, a reader also
checks every existing folder or file on the way to a path, and the one it replaces: each must have
exactly the name the path gives, not a short 8.3 alias (§7.4). Otherwise the write is refused and
reported.

## 12. Golden vectors

The vectors are in [`remote-format-vectors/v1/`](remote-format-vectors/v1/). Bytes are lowercase
hex, and `hex` is authoritative; JSON documents also appear as `text` for reading. A long value can
be given as a `value_pattern` (`repeat` × `count` followed by `then`). `reason` strings are
informative: a reader must reach the same outcome (valid, `newer`, `missing`, invalid), not the same
words.

| File | Holds |
|---|---|
| `hashes.json` | Content hashes and blob ids, from empty input to 1 MiB + 1 byte (patterns `i mod 251`, as BLAKE3's own vectors); `derive_key` outputs for both contexts; the same bytes as blob, tree and commit |
| `canonical-json.json` | Documents to accept or refuse (white space, key order, escapes, numbers, `null`, duplicate keys, lone surrogates, invalid UTF-8, a byte order mark, depth) and values to encode |
| `values.json` | Names (§6.4, NFC included), paths, times, display names, summaries, bodies, ids |
| `objects.json` | The example library: every file version's bytes and content hash, every tree and commit with its canonical bytes and id, each commit's flattened tree by root id, and objects that are invalid on their own |
| `commit-rules.json` | Commits read with their parents (coverage, sides, folder moves, moves written as deletes and adds, `changes` left out, prune rules, a subtree that has not arrived); change records on small trees (a swap, a file replaced by a moved file, a file that becomes a folder, a folder renamed and created again, a file moved with a copy left behind); the root rules of §7.4 with path lengths; which absent blobs are pruned and which may be deleted |
| `packs.json` | One pack per commit of the example library (zstd frames in two; the fifth brings back a thinned blob) and 37 variants: valid frames of every block and header kind (an 8 MiB window included), newer, and invalid |
| `records.json` | `FORMAT.json`, head records and intents of the example's pushes, valid, newer and invalid, each with its path in the remote (provisional until v0.3) |

**The example library** has a course `2026 秋/线性代数` with Markdown, PDF and Word files, a folder
of lectures, an empty folder, names that sort differently by UTF-8 and by UTF-16 (`Ａ.txt` and
`😀.md`) or by case (`B.md` before `a.md`), and five commits:

| Commit | Device | Kind | What it shows |
|---|---|---|---|
| c1 | A | `commit` | A first commit: only `add` records |
| c2 | A | `commit` | Edits; a file moved out of a folder that then goes; tags that follow the move; a folder renamed with one of its files edited; a new Word version; a deletion |
| c3 | B (Chinese name) | `import` | An iPad edit, rebased onto c2 (`rebased_from`), with a body that needs escapes |
| c4 | A | `prune` | Thins out the first Word version |
| c5 | A | `commit` | Restores that version, so its blob comes back |

**How they were made.** [`generate.mjs`](remote-format-vectors/generate.mjs) writes them: a second
implementation of this spec in JavaScript, independent of `folio-core`, with BLAKE3 written from
the reference implementation. Each invalid vector is built to break one rule, and the generator's
own reader confirms every outcome. The zstd frames it did not build by hand were made once with the
libzstd that Node 24.19.0 bundles and are kept in the generator as data. On 2026-10-03 a separate
program recomputed every hash, id, pack trailer, index, record walk and canonical encoding with the
official Rust `blake3` 1.8.7 and `serde_json` 1.0.151, and checked every name and path vector
against `folio-core`'s own `paths::check_name` and `RelPath`: 628 checks, all equal. It did not
decode zstd frames or check refusals beyond names and paths. `pnpm check` runs
`generate.mjs --check`, which confirms that the files match the generator.

**Rules for the vectors.** Once v0.2 ships they never change (`records.json` once v0.3 ships): a
fix to the format is a new version with a `v2/` folder, and version 2 readers must still pass
`v1/`. `folio-core` tests every file (`feat/core-object-store`); a future Swift app should too.

## 13. Notes for other implementations

- **BLAKE3:** the official C library (`blake3_hasher_init_derive_key` for trees and commits), or
  `folio-core` itself through UniFFI (ADR-0001).
- **zstd:** facebook/zstd (a Swift package exists). Check frames with `ZSTD_findFrameCompressedSize`
  (one frame, nothing after it) and `ZSTD_getFrameHeader` (window, dictionary, content size) before
  decoding, and decode into a buffer of exactly the raw length. A writer need not state the content
  size.
- **JSON:** write with a canonical encoder of your own. General encoders escape `/`, sort keys by
  their own string order, or write integers as floating point. Read with a parser that keeps
  integers exact, refuses duplicate keys and limits depth, then encode again and compare (§5).
- **Sorting:** compare names and paths by their UTF-8 bytes (`Array(name.utf8)` in Swift); Swift's
  `<` on `String` does not.
- **Names:** Apple file systems keep names as they were created, and names from an iPad may be NFD;
  write NFC (`precomposedStringWithCanonicalMapping`) and check §6.4 before writing a tree.
- **Integers:** 64-bit; refuse JSON integers above 2^53 − 1.

## 14. Refinements to ADR-0003

Approved with this spec on 2026-10-03; ADR-0003's text now includes them.

1. **§2 Encoding.** Canonical JSON is the RFC 8785 subset of §5: no `null`, integers to 2^53 − 1,
   16 levels deep at most.
2. **§2 Commit fields.**
   - `message` becomes `summary` and an optional `body`, the two fields of the commit box (brief
     §5.4).
   - `parent` is left out on a first commit instead of being `null`.
   - `kind` gains `prune` (§7.5).
   - Change records carry `kind` (`file` or `dir`), `from` instead of `from_path`, and `old` and
     `new` with hash, size and `stored` instead of `old_hash` and `new_hash`: the history shows size
     changes (brief §5.6) without reading trees.
   - Folders have records, so empty folders show; a folder move covers what moved with it (§8).
   - `changes` is optional.
3. **§2 Trees.** A folder entry has no `size` or `stored`; `stored` follows the commit's own rules
   (§7.2); §7.4 fixes what `.folio/` may hold and adds the path-length rule.
4. **§3 Packs.** Little-endian fields of fixed width (§9). The trailer holds the index's entry count,
   an end magic and the hash; the hash covers everything before it, the count included, where
   ADR-0003's footer left the index offset outside it. zstd frames fit an 8 MiB window and decode to
   exactly the raw length.
5. **§3 Local and remote stores.** One *or more* packs per commit locally and per push remotely,
   instead of exactly one (§9.5): large Word versions get packs of their own.
6. **§5 Remote rules.** Packs may be deleted after thinning, under §10.1's rules (ADR-0006). Intents
   and heads share a per-device counter. A head is complete when every object reachable from it is
   present or pruned, wherever it is, rather than when "its packs" are present (§6).
7. **§13 Compatibility.** Made exact in §3: a version per part, read first; strict within a
   version; every change raises it; newer files are not interpreted; writers write the lowest version
   a file needs.
8. **§13 Scope.** The mirror rules belong to sync.md (§1), not to this spec.

## 15. Decisions

Sirui's choices on 2026-10-03 that shape this format:

- **Retention:** thin out old Word versions over time (ADR-0006): the prune commits of §7.5 and the
  pack deletion of §10.1.
- **Size limits and versioned files unchanged:** text files up to 10 MiB and every `.docx`, at any
  size, keep their versions (library.json's defaults). The format does not depend on either:
  `stored` follows the rules in each commit, so a later change of rules needs no new format version.
