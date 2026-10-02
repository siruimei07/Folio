# Roadmap data and explorer

The roadmap's live state — every lane, its status, dependencies, checks, paths and start
prompt, the landing queue, Sirui's open decisions, risks and loose ends — is one file:
[`roadmap.json`](roadmap.json). `docs/product/roadmap.md` (Chinese, for Sirui) keeps the
stable narrative and points here. The explorer page renders the same data as boards for
Sirui; the CLI reads and updates it for agents. Both derive statuses, paths and prompts
through one module, [`tools/lib.mjs`](tools/lib.mjs).

| File | What it is |
|---|---|
| `roadmap.json` | The data. Chinese text for Sirui (titles, summaries, next steps), English prompts and ids |
| `index.html` | The explorer template; `build` and `serve` inline `tools/lib.mjs` and the data |
| `tools/roadmap.mjs` | The CLI behind `pnpm roadmap` |
| `tools/lib.mjs` | Pure logic shared by the CLI and the page: derived status, graph walks, prompts, validation, formatting |
| `tools/lib.test.mjs` | Unit tests; `pnpm check` runs them and `pnpm roadmap check` |
| `dist/explorer.html` | Built page for publishing (git-ignored) |

## When to update (every lane, CLAUDE.md §7.3)

Change only your own lane's entry, so parallel lanes' edits stay separate GitButler hunks.
The CLI writes canonical formatting, which keeps each lane's volatile fields (`status` …
`next`) in the middle of its object, away from its neighbours.

| Moment | Command | Commit it |
|---|---|---|
| Lane starts (no entry yet: add one by hand, then `pnpm roadmap fmt`) | `pnpm roadmap status <lane> wip --next "<what you are doing>"` | with your first checkpoint |
| Checks or reviews finish | `pnpm roadmap gate <lane> check=pass e2e=pass codeReview=pass …` | with the checkpoint |
| Lane reaches review | `pnpm roadmap status <lane> review --next "<what Sirui approves>"`, and add it to `landingQueue` | with the last commit |
| Right before `but land` | `pnpm roadmap status <lane> done` (sets `landed`, drops `next`, removes it from the queue) | on the lane branch, so main shows it done exactly when it lands |
| Sync points only | `pnpm roadmap log "<text>"`, edit `now`, `decisions`, `limits`, `runtime` | in a roadmap lane: these are shared hunks |

Run `pnpm roadmap next` at the start of a session for the landing queue, active lanes, what
can start and what needs Sirui, and `pnpm roadmap doctor` to compare the data with
`.agents/lanes/` and the Git branches. `pnpm check` fails on invalid or non-canonical data.

## Commands

```text
pnpm roadmap next                         where things stand
pnpm roadmap show <lane>                  one lane: what it waits for and unblocks, gates, paths
pnpm roadmap prompt <lane>                its copyable prompt (custom, template or the generic start prompt)
pnpm roadmap status <lane> <status>       done | review | wip | planned | dropped
      [--next "…"] [--hold "…" | --no-hold] [--landed YYYY-MM-DD]
pnpm roadmap gate <lane> <gate>=<state>…  gates check e2e codeReview securityReview simplify designCritique a11y;
                                          states pass partial fail todo na
pnpm roadmap note <lane> "<text>"
pnpm roadmap log "<text>" [--by <name>]
pnpm roadmap doctor | check | fmt | build | serve [--port 5199]
```

`<lane>` is the branch name, its lane-file form (`feat--ui-preview`) or a unique tail
(`ui-preview`). `serve` is also `.claude/launch.json`'s `roadmap` configuration, so the
browser pane opens it with `preview_start roadmap`.

## Data model

Top level: `meta`, `now` (stage, focus milestone, summary lines), `limits` (session caps),
`runtime` (app lock holder, dev server, devices), `agents`, `tracks` (graph rows), `milestones`,
`phases` (graph columns, in order; `kind` is `wave`, `sync` or `gate`), `lanes`,
`landingQueue` (ordered `{ lane, why }`), `decisions` (`approve | decide | manual`,
`open | recurring | locked | done`), `looseEnds`, `risks`, `rules` (roadmap.md §4's numbered
rules), `prompts` (templates), `log`.

A lane, in canonical field order (`?` = optional):

| Field | Meaning |
|---|---|
| `id` | Branch name, `<type>/<area>-<desc>`; milestone gates are `gate/…` with `kind: "gate"` |
| `kind?` | `"gate"` for an acceptance gate |
| `title`, `summary` | Chinese, for Sirui |
| `milestone`, `phase`, `track`, `agent`, `reviewer?`, `size` | Placement; `size` is S, M or L (critical-path weight 1, 2, 3) |
| `effort?` | Reasoning effort to run the lane's session at with `meta.model` (`low`, `medium`, `high`, `xhigh`, `max`). Without it: S medium, M high, L xhigh, one step up for `core`, one down for `docs/` lanes. Set it when the work is lighter (landing only) or heavier (formats, crash recovery, security) than its size says |
| `deps` | Lanes that must land before this one can start; drives ready / locked |
| `landAfter?` | Landing order only (no code dependency) |
| `status` | Stored: `done`, `review`, `wip`, `planned`, `dropped`. A planned lane shows as ready when every dep is done, queued when it also has `hold`, else locked |
| `hold?` | Why a ready lane should still wait (planned only) |
| `updated`, `landed?` | `YYYY-MM-DD` |
| `next?` | The next step, for active lanes |
| `gates?` | Check results: `pass`, `partial`, `fail`, `todo`, `na` |
| `owns?`, `shared?` | Paths (globs allowed); the explorer's ownership board flags paths two active lanes touch |
| `notes?`, `links?` | Notes and doc paths (relative to the repo root) |
| `prompt?` | Lines, or `{ "template": "land" | "reviewCodex" | "landRoadmap", "extra": [lines] }`. Without it a planned lane gets `prompts.start`; a planned Codex lane also gets `prompts.codexPreamble` |

Template placeholders: `{lane}`, `{laneFile}` (`/` → `--`), `{taskDir}` (`/` → `-`),
`{milestone}`, `{phase}`, `{summary}`, and a line `{extra}`.

## Publish

The explorer is a private claude.ai Artifact for Sirui: <!-- explorer-url --><https://claude.ai/artifact/Mv1f9eXfrkYTbAs7fqQVDC><!-- /explorer-url -->.
After changing the data on main (or when Sirui asks for a fresh view):

1. `pnpm roadmap check` and `pnpm roadmap build`.
2. Artifact tool: `read` the URL above once in the session, then `publish` with
   `file_path` = `docs/roadmap/dist/explorer.html` and `url` = that URL. Never publish to a
   new URL: the link is what Sirui keeps.
3. `meta.explorer` in `roadmap.json` holds the same URL; the page shows it under "给 agent".

Locally, `pnpm roadmap serve` (or `preview_start roadmap`) shows the working copy at
<http://localhost:5199>, rebuilt on every reload.
