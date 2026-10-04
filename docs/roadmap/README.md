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
| Sirui opens a session for a ready lane (optional) | `pnpm roadmap status <lane> claimed`, or the button in the lane drawer of the local explorer (`pnpm roadmap serve`) | with the lane's first checkpoint, if the session has not set `wip` yet |
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
      [--codex | --audit]                 a Codex lane: the full handoff to Codex, or the short Claude Code audit
pnpm roadmap status <lane> <status>       done | review | wip | claimed | planned | dropped
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

Top level: `meta` (with `models`, the display names of `fable`, `opus` and `sonnet`, and
`pausedModels`, models not to recommend for now: Opus 5.5 stands in for them at the same effort,
also where a lane names one; `["fable"]` since 2026-10-03), `now` (stage, focus milestone, summary lines), `limits` (session caps),
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
| `model?` | Model to run the lane's session on: `fable` (Fable 5.1, the most capable), `opus` (Opus 5.5, the everyday default) or `sonnet` (Sonnet 5.5). Without it: Fable for the work hardest to undo (gates, `docs/specs-*`, `feat/ipc-*`, effort `max`); Sonnet for docs-only lanes (`docs/docs-*`) and landing-only prompts (`prompt.template` `land`); Opus otherwise (screens, core, tests, design) |
| `effort?` | Reasoning effort for that session (`low`, `medium`, `high`, `xhigh`, `max`; all three models take all five). Without it: S and M high, L xhigh; one step up for `core`, gates and specs (an L core lane reaches `max`), one down for `docs/docs-*` lanes and landing-only prompts. Set it when the work is lighter or heavier (formats, crash recovery, security) than its size says |
| `auditModel?`, `auditEffort?` | Codex lanes only: model and effort for the Claude Code audit. Without them: S Opus · medium, M Opus · high, L Fable · xhigh |
| `deps` | Lanes that must land before this one can start; drives ready / locked |
| `landAfter?` | Landing order only (no code dependency) |
| `status` | Stored: `done`, `review`, `wip`, `claimed`, `planned`, `dropped`. A planned lane shows as ready when every dep is done, queued when it also has `hold`, else locked. `claimed` (🙋, teal) means Sirui opened a session for a ready or queued lane and it has not set `wip` yet: `pnpm roadmap next` lists it under Claimed instead of "Can start now", and `planned` takes the mark back |
| `hold?` | Why a ready lane should still wait (planned or claimed) |
| `updated`, `landed?` | `YYYY-MM-DD` |
| `next?` | The next step, for active lanes |
| `gates?` | Check results: `pass`, `partial`, `fail`, `todo`, `na` |
| `owns?`, `shared?` | Paths (globs allowed); the explorer's ownership board flags paths two active lanes touch |
| `notes?`, `links?` | Notes and doc paths (relative to the repo root) |
| `prompt?` | Lines (the whole prompt), or `{ "template"?: "<name in prompts>", "extra": [lines] }`. Without `template`, and without `prompt` at all for a planned lane, the lane gets the start template for its kind (`startTemplate` in tools/lib.mjs): `gate`, `startDesign` (Cowork), `startSpec` (`docs/specs-*`), `startUi`, `startCore` (Claude Code core and contract lanes), `startVerify`, else `start`; `extra` holds the lane's own detail. A Codex lane (`agent: "codex"`) gets two prompts instead: `prompts.codexHandoff` (the whole lane for Codex; plain lines are its `extra`) until it reaches review, and `prompts.codexAudit` (the Claude Code audit). Any other template on a Codex lane means Claude Code has taken it over and is its audit (`reviewCodex` for feat/core-import) |

Template placeholders: `{lane}`, `{title}`, `{laneFile}` (`/` → `--`), `{taskDir}` (`/` → `-`),
`{milestone}`, `{phase}`, `{summary}`, `{deps}`, `{unblocks}` (the lanes that list it in `deps`), `{owns}`, `{shared}`, `{links}`, `{model}` and
`{effort}` (the lane's session), `{auditModel}` and `{auditEffort}` (a Codex lane's audit), and a
line `{extra}`.

Codex lanes: Codex does backend Rust only (`AGENTS.md`), runs its own checks, code review and
simplify pass, writes `folio-agent-work/tasks/<lane>/claude-review-handoff.md` and stops at
review. Claude Code then audits (Sirui, 2026-10-02; stronger since 2026-10-03): one `/code-review`,
`/security-review` only for the privileged layer, IPC or unsafe code, no second `/simplify`.
A lane that regenerates the bindings and the fake shell stays with Claude Code.

## Publish

The explorer is a private claude.ai Artifact for Sirui: <!-- explorer-url --><https://claude.ai/artifact/Mv1f9eXfrkYTbAs7fqQVDC><!-- /explorer-url -->.
After changing the data on main (or when Sirui asks for a fresh view):

1. `pnpm roadmap check` and `pnpm roadmap build`.
2. Artifact tool: `read` the URL above once in the session, then `publish` with
   `file_path` = `docs/roadmap/dist/explorer.html` and `url` = that URL. Never publish to a
   new URL: the link is what Sirui keeps.
3. `meta.explorer` in `roadmap.json` holds the same URL; the page shows it under "给 agent".

Locally, `pnpm roadmap serve` (or `preview_start roadmap`) shows the working copy at
<http://localhost:5199>, rebuilt on every reload. Only this page can write: its "标记已领取" /
"取消领取" button in the lane drawer POSTs to `/claim`, which accepts same-origin JSON only and
sets nothing but `claimed` and back to `planned` (`claimToggle` in `tools/lib.mjs`). On the
published page the same button copies the `pnpm roadmap status` command instead.
