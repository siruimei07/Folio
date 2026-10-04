# ADR-0006: History retention: thinning old Word versions

- **Status:** Accepted (Sirui, 2026-10-03), together with
  [`remote-format.md`](../specs/remote-format.md) (decision `remote-format`).
- **Date:** 2026-10-03
- **Deciders:** Sirui Mei
- **Inputs:**
  - [`docs/product/brief.md`](../product/brief.md) §4, §5.6, §9, §12 (constraints 1 and 3);
  - [ADR-0003](ADR-0003-versioning-and-sync.md) §3, §5, "Revisit when";
  - [`remote-format.md`](../specs/remote-format.md) §7.5, §9.5, §10.1;
    [`versioning.md`](../specs/versioning.md) §5.4.

## Context

- ADR-0003 keeps every stored version forever. Its remote store is write-once, and "v1 has no remote
  garbage collection", as brief §12 asked: the remote's history only grows (constraint 1), and text
  and Word files keep every version (constraint 3). ADR-0003 names a retention policy as something
  to revisit when Word history grows too large.
- Word versions are where the space goes. A `.docx` is already compressed and every version is
  stored whole, while text versions compress to a few kilobytes. A 2 MB report saved in 15 commits
  costs 30 MB; a 60 MB thesis with many figures, committed 50 times, costs 3 GB. Each version is
  stored twice: in the local store and in iCloud.
- The history format is frozen once v0.2 writes it into every library (remote-format.md §1). If
  versions may ever be removed, readers must understand that from version 1 on; otherwise adding it
  later raises the format version and every device must update.
- Sirui decided on 2026-10-03, asked with concrete options:
  1. old versions are thinned out over time (rather than kept forever, or the last N kept per file);
  2. only Word versions: text versions are tiny and every version of notes and code stays useful;
  3. all versions for 30 days, then one a day up to 6 months, then one a week.

  This departs from brief §12's constraints 1 and 3 for Word versions only; the brief records the
  decision in §5.6.

## Decision

### 1. The policy

Thinning applies to the stored versions of Word files only. Text files, the library's metadata
files and every version that is current in the newest commit are kept. Versions belong to a file's
line, which follows the file through moves. versioning.md §5.4 states the rule exactly; in short:

| Age | Kept, per file |
|---|---|
| Up to 30 days | Every version |
| 30 days to 6 months (183 days) | The last version of each day (UTC) |
| Older | The last version of each ISO week (UTC) |

Days and weeks are counted in UTC, so every device draws the same boundaries.

**Clocks can be wrong**, and commits carry the time of the device that made them. A version's age
is therefore measured from its commit's *effective time*, the later of the commit's own time and
its parent's effective time, which never decreases along the history; a device whose clock is
earlier than the newest effective time thins out nothing.

### 2. Prune commits record what was thinned

Thinning appends a commit of kind `prune` to the linear history (remote-format.md §7.5). Its tree is
its parent's; it lists the blobs that the versions before it no longer keep. Commits and trees are
never removed, so the history still lists every change; a thinned version shows as not kept,
without a diff or a restore. A later commit that stores the same content again brings it back: its
writer stores the blob again, and no store deletes it while that commit keeps it.

The job runs at most once a day, as the first step of a commit job, so the prune commit goes below
the user's new commit and the newest commit stays one the user can uncommit (versioning.md §8.4).

### 3. Compaction removes the bytes

- **Each device decides for itself.** A device deletes a blob only when a prune commit lists it
  *and* its own evaluation of the rule, with its own clock, agrees. A device with a wrong clock can
  thin out its own history, but it cannot make the others delete.
- **Locally**: packs that hold deletable blobs are rewritten without them and the old packs
  deleted, the new pack being durable first. Without a remote this follows the prune commit at
  once; with one, it waits until the prune commit is canonical (M3), because a rebase may still
  change its list. A Word version of at least 1 MiB has a pack of its own (remote-format.md §9.5),
  so compaction mostly deletes whole packs instead of rewriting them.
- **On the remote**, packs are deleted only under remote-format.md §10.1: only a pack each of whose
  objects may be deleted or is in another pack, at least 30 days after the deleting device first saw
  the prune commit (by its own clock, never trusting the times written in the files), and through
  the Recycle Bin, so iCloud keeps them 30 days more. This replaces ADR-0003 §5's "v1 has no remote
  garbage collection".

### 4. When it arrives

In M3 (lane `feat/core-retention`, proposed), after sync exists, because remote compaction needs the
sync rules. Until then nothing is thinned: keeping more is always safe, and the first thinning
catches up.

## Options considered

### Policy (Sirui's choice)

| Option | Space | Recovery | Verdict |
|---|---|---|---|
| Keep every version forever | Grows with every save; a few GB per degree, mostly Word | Every version | Simplest. Not chosen |
| Keep the last N versions per file | Bounded per file | Recent edits only: a file saved often loses last month's versions quickly | Not chosen |
| **Thin out by age (chosen)** | Bounded over time | Every version for 30 days, then a version per day, then per week | The Time Machine pattern: dense where edits matter, sparse where they rarely do |

### Which files

| Option | Verdict |
|---|---|
| **Word only (chosen)** | Word holds nearly all the space; text versions cost kilobytes |
| Text and Word | Saves little more, and loses fine-grained history of notes and code |

### Mechanism

| Option | Assessment |
|---|---|
| Each device thins only its local store; the remote keeps everything | No coordination, but iCloud, where space costs money, keeps growing |
| Device-owned prune lists in the remote (`prunes/<device>/<seq>.json`) | Works, but adds a second ordering of events beside the history; a prune and a restore of the same content on two devices need extra rules |
| **Prune commits in the linear history (chosen)** | Ordered by the same canonical-head rules as every commit and rebased like them (ADR-0003 §6); visible in History; a reader learns which blobs are pruned from the history it already reads; a later commit that brings the content back simply carries the blob again |

### Day boundaries

| Option | Verdict |
|---|---|
| **UTC (chosen)** | The same on every device; a "day" ends at 8 PM in Toronto in summer, which only shifts which version of a day is kept |
| The device's local time | Natural for the user, but two devices, or one device that travels, would draw different boundaries |

## Trade-off analysis

- **Space against recovery.** After 6 months a document keeps about one version a week. A version
  from a busy week of edits is gone. The current version, everything from the last 30 days and the
  end of every day for half a year remain.
- **Simplicity against an append-only remote.** ADR-0003's strongest safety argument was that the
  history area is never rewritten. Packs can now be deleted, but only packs whose live objects exist
  elsewhere, only long after the decision, and only through the Recycle Bin. A device that has not
  synced for over 30 days may find versions gone that it never saw; it never loses a current file or
  a commit.
- **Wrong clocks.** Effective times and each device's own evaluation keep a wrong clock from
  deleting anything early on another device. A device whose clock runs ahead can still thin its own
  versions early; History then shows them as not kept.
- **Now against later.** The format supports thinning from version 1, so no device has to update for
  it; the code arrives with M3. Until then libraries keep everything.

## Consequences

**Easier**
- Word history stops growing without bound.
- Every change stays in History, with its size and time, after its content is thinned out.

**Harder**
- Compaction, locally and on the remote, is new code with crash-safety and simulation tests (the
  sync simulation must include prune commits, pack deletion and devices with wrong clocks).
- The remote is no longer append-only; sync.md must specify deletion carefully.
- A thinned version cannot be restored, by design. The History view and the restore confirmation
  must say which versions are kept (design lanes).

**Revisit when**
- Text history grows large after all (very large notebooks or data files under the 10 MB limit).
- Sirui wants different thresholds; they would become a library setting in `library.json` (a
  metadata format change, not a history format change).
- Versions of other file types are kept (brief §8 excludes them in v1).

## Action items

1. [x] Sirui approves with remote-format.md; set Status to Accepted (2026-10-03).
2. [x] Format support: prune commits (remote-format.md §7.5) and the deletion rules (§10.1).
3. [x] The exact rule: versioning.md §5.4.
4. [ ] `docs/specs-sync`: the remote compaction procedure and its grace period.
5. [ ] A lane `feat/core-retention` in M3: the thinning job, local and remote compaction, crash
   injection, and the sync simulation's invariants with pruning ("nothing ever canonical is lost"
   becomes "nothing ever canonical is lost unless a prune commit lists it and every device's own
   evaluation agrees").
6. [x] Brief §5.6 states the policy, and §12 notes the exception (this lane).
