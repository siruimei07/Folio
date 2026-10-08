# CLAUDE.md — Folio

Operating manual for every agent working in this repository: Claude Code sessions on
Sirui's Windows machine and Cowork sessions (Claude desktop app). Read it fully at the
start of each session. When this file conflicts with a skill's default behaviour, this
file wins. When it conflicts with an explicit instruction from Sirui in the current
conversation, Sirui wins.

---

## 1. Project snapshot

| Item | Value |
|---|---|
| Name | Folio |
| Owner | Sirui Mei (sole decision-maker for product, scope and merges) |
| Platforms | Desktop — Windows 10/11 only (decided 2026-09-26). macOS is out of scope; a future Mac version would be a separate Swift app. |
| Product one-liner | Windows desktop document library for students: files organised in semester → course folders with multi-select category tags, quick search, in-app preview, and a GitButler-style change history (full versions for text and Word files, change events only for everything else), pushed to and pulled from a plain folder in iCloud Drive that serves as a versioned backup other devices can browse. Scope and decisions: [`docs/product/brief.md`](docs/product/brief.md) (Chinese). Do not extend scope beyond it without asking. |
| Tech stack | Tauri 2 shell + React 19 / TypeScript UI + Rust core crate `folio-core` ([ADR-0001](docs/adr/ADR-0001-application-stack.md), accepted 2026-09-26). Pins (exact versions live in the files named): Node 24 (`.nvmrc`), pnpm 11 (`packageManager`), Rust (`rust-toolchain.toml`), Tauri 2.12 (`Cargo.lock` and `package.json`), TypeScript 6.0 (`catalog` in `pnpm-workspace.yaml`; typescript-eslint does not support TypeScript 7 yet). |
| Repo | Scaffolded 2026-09-26 (§6 milestone 7): Cargo + pnpm workspaces, placeholder UI, CI; no product features yet. GitButler workspace mode, target `origin/main`. Remote `github.com/siruimei07/Folio`, public since 2026-10-07, licensed MIT (Sirui switched it from GPL-3.0 the same evening); its history was rewritten that day to one commit per lane, and the original 648 commits are in the private `siruimei07/Folio-archive`. |
| Local path | `D:\CS Projects Repositories\Files & Backup\Folio` (device `DESKTOP-N7UG6S7`, since 2026-10-02; before that `E:\CS Projects Development\Documents Manage\Folio` on `g16-strix`). Open agent sessions in this folder, not its parent. The path has spaces and an `&`: quote it everywhere. Develop on one device at a time (lane files and locks are not in Git). |
| Local toolchain | Node 24.19.0, pnpm 11.25.0, Rust 1.97.1, VS 2022 Build Tools (MSVC, Windows SDK), WebView2 154, GitButler 0.22.3 (`D:\Program Files\GitButler`, on the user PATH), Python 3.14, Claude Code 2.1.286 (as of 2026-10-02). ADR-0001 pins the versions the project uses. |

---

## 2. Language policy (strict)

| Audience | Language | Covers |
|---|---|---|
| Agents | **English** | Reasoning and plans, this file, ADRs, specs and design-handoff docs, lane files, code, code comments, identifiers, test names, commit messages, branch names |
| Sirui | **Simplified Chinese (简体中文)** | Every chat reply, progress update, question (including AskUserQuestion options), end-of-task summary, and every document written for Sirui to read (research plans, review reports, decision memos, user guides) |

- Keep standard technical terms in English inside Chinese text when no settled translation exists (IPC, design token, hunk, ADR).
- When an English agent doc needs Sirui's decision, do not ask him to read it: summarise the decision and options in Chinese in chat.
- In-app UI language: English in v1 (decided 2026-09-27, product brief §3; it replaces Simplified Chinese, decided 2026-09-26); a Simplified Chinese UI comes in a later version. Chinese file names and content still display and are searchable. All user-visible strings are externalised (i18n-ready) from the first component; no hard-coded UI strings (ESLint `i18next/no-literal-string`). Strings live in `apps/desktop/src/i18n/locales/en/`, one namespace per view: a lane adds strings only to its view's namespace, and `tsc` checks every `t()` key against `en` (`apps/desktop/src/i18n/README.md`).

---

## 3. Working principles

1. **Read before you write.** Explore existing code and docs before designing or editing. Reuse an existing pattern instead of re-implementing it; if two patterns exist, consolidate. A previous project (CourseFlow) suffered from the same pattern duplicated across many files — do not repeat that.
2. **Decisions are written down.** Any technical choice that would be costly to reverse goes into an ADR in `docs/adr/` before implementation.
3. **Design is a first-class input.** UI work starts from a design-handoff spec (§4), never from improvisation in code.
4. **Engineering defaults are yours; product decisions are Sirui's.** Pick sensible engineering defaults and record them. Ask Sirui (in Chinese, via AskUserQuestion with concrete options) only for product, scope, or visual-direction choices.
5. **Use only the listed skills.** Use the skills in `docs/agents/skill-routing.md` and nothing else; do not install skills or plugins without Sirui's approval. If a listed skill is unavailable in the current environment (Claude Code vs Cowork), tell Sirui once (in Chinese), use the closest available alternative, and continue. Never skip the step silently.
6. **Stay in your lane.** Parallel sessions share one working directory (§7). Only edit paths your lane owns.
7. **Enforce rules with config where possible.** When a rule here can be enforced by a setting, hook, lint rule or test, prefer that over prose, and note the enforcement next to the rule.

---

## 4. Skills and feature pipeline

The full routing table — which skill to use for which job, and which to avoid — lives in
[`docs/agents/skill-routing.md`](docs/agents/skill-routing.md). It is also the complete list
of skills in use. Read it before design, UI, motion, backend or review work.

### 4.1 Non-negotiable skill uses

- Backend, data or IPC work starts with `engineering:system-design`; costly decisions go through `engineering:architecture` into an ADR.
- UI work starts from a handoff spec in `docs/design/handoff/` produced with `design:design-handoff`.
- Every new screen passes `design:design-critique` → `design:accessibility-review` before its lane is done; every animation has a `prefers-reduced-motion` fallback.
- Every change gets `engineering:code-review` (or `/code-review`), with explicit attention to swallowed errors and to new or changed types; changes to the privileged layer or IPC surface also get `/security-review`.
- Any chart, stat tile or dashboard uses `dataviz`.

### 4.2 Feature pipeline (default order)

1. **Frame** — new or unclear flow → `design:user-research`; otherwise skip.
2. **System** — `engineering:system-design` (data model, IPC contract, modules) → `engineering:architecture` for any costly decision.
3. **Design** (Cowork) — `design:design-system` tokens → Design canvas mockup → `design:design-critique` → `design:accessibility-review` → `design:design-handoff` → spec saved to `docs/design/handoff/<feature>.md`.
4. **Plan tests** — `engineering:testing-strategy`.
5. **Build** (Claude Code) — explore existing code first (§3.1), then implement; use `frontend-design` for UI.
6. **Verify** — unit/integration tests, Playwright e2e for UI flows, `design:accessibility-review` on the built screen (`run` + browser pane), reduced-motion check.
7. **Review** — `engineering:code-review` (or `/code-review`), `/security-review` for changes in the privileged layer → `/simplify`.
8. **Ship** — commit on the lane branch (§7), report to Sirui in Chinese, land only on his approval.
9. **Periodic** — `design:research-synthesis` after feedback rounds; `engineering:tech-debt` at milestones; `engineering:deploy-checklist` before every release.

---

## 5. Engineering guardrails

- **Privilege boundary.** The UI layer is untrusted. File-system, database and OS access live only in the privileged layer and are exposed through a narrow, typed, validated IPC surface. In Tauri: each feature group owns its commands in `crates/folio-app/src/commands/<group>.rs`, lists them for runtime registration and the app manifest (`build.rs`) in `commands/<group>/manifest.rs`, and grants them per window in `crates/folio-app/capabilities/<group>.json`, which lists individual permissions only (no `core:default` or other default sets; a test in `ipc.rs` checks this); `withGlobalTauri` stays off; the production CSP in `tauri.conf.json` allows no `'unsafe-inline'` (only `devCsp` may). Planned commands are the one exception: declared as test-only stubs in their group's `commands/<group>.rs` for the bindings only, they are never registered, listed or granted until their lane implements them (`docs/specs/ipc-m1.md` §3, `docs/specs/library-state.md`; another test in `ipc.rs` checks this).
- **One IPC contract.** Request/response types for every channel are defined once and used by both sides. Rust types in `folio-app` are the source of truth; `apps/desktop/src/ipc/bindings.ts` is generated by `cargo test -p folio-app export_bindings` (never edit it; that test, part of `pnpm check`, fails when the file was stale and rewrites it). Only contract lanes change the bindings (roadmap §4 rule 2), and they update the fake shell in `apps/desktop/src/ipc/mock/` in the same change (`contract.test.ts` fails until its `REVIEWED_BINDINGS` fingerprint matches). The UI reaches the shell only through `apps/desktop/src/ipc`; its commands never reject, and a failed call arrives as a `Transport` error. Validate every payload on the privileged side. No 64-bit integers in IPC types (JavaScript loses precision); use strings. specta-typescript already refuses them, so the export fails; never bypass that with `#[specta(type = specta_typescript::Number)]`. Prefer 32-bit integers to floats in input types: specta exports `f64` as `number | null`.
- **Core stays shell-agnostic.** `folio-core` has no Tauri, UI or IPC types (ADR-0001); the shell converts core types to IPC types.
- **New dependencies are at least one day old.** pnpm enforces this with its minimum release age (`minimumReleaseAge` and `minimumReleaseAgeStrict` in `pnpm-workspace.yaml`: the install fails on a younger version); never add `minimumReleaseAgeExclude` entries. Apply the same rule to crates (pin with `cargo update --precise`) and GitHub Actions (pin to a release's commit SHA). Pin release candidates exactly.
- **No silent failures.** Every IPC handler and data-layer function returns or throws a typed error; the UI renders an explicit error state (copy via `design:ux-copy`).
- **Design tokens are the only source of visual values.** No hard-coded colours, spacing, radii, font sizes or durations in components. `design:design-system` audits this. Use one icon family across the app; never mix icon sets. Components read the CSS custom properties in `apps/desktop/src/tokens/tokens.css`, generated from `design/tokens/` (`pnpm --filter @folio/desktop tokens`, never edited by hand); a test in `pnpm check` fails when it is stale or when a stylesheet reads a property nothing defines.
- **Motion** respects `prefers-reduced-motion`; durations and easings come from tokens.
- **Accessibility** baseline: WCAG 2.1 AA contrast, full keyboard operation, visible focus, adequate hit targets.
- **Data.** Schema is versioned from the first release; every schema change ships with a migration and a migration test.
- **Platform.** Windows only (§1). Still keep path handling and every on-disk format platform-neutral: iPad and Mac write into the iCloud remote, and a future Swift app must read it. No shell-specific scripts in `package` scripts. The local path contains spaces — quote every path in scripts and tool calls.
- **Text files.** UTF-8 without BOM, LF line endings (`.editorconfig` and `.gitattributes` enforce this; `*.cmd` / `*.bat` are CRLF). This machine's ANSI code page is GBK and Windows PowerShell 5.1 defaults to it, which corrupts Chinese text and em dashes. Create and edit files with the Write/Edit tools — never `Set-Content`, `Out-File` or `>` redirection — and pass `-Encoding UTF8` when reading files with `Get-Content`.

---

## 6. First milestones

1. **Bootstrap** — done 2026-09-26 (§9).
2. **Product brief** — drafted 2026-09-26 in `docs/product/brief.md` (Chinese); it fills §1 "Product one-liner", and its §12 lists the product constraints each ADR below must meet.
3. **ADR-0001: Application stack** — accepted 2026-09-26: Tauri 2 + React + TypeScript with a Rust core (`docs/adr/ADR-0001-application-stack.md`). Original brief: (`engineering:system-design` then `engineering:architecture`). Candidates: Electron + React + TypeScript vs Tauri + React + TypeScript. Scope is Windows only (§1), so the macOS WebDriver and WKWebView concerns below no longer apply. Must weigh: e2e testability with Playwright (first-class for Electron; Tauri needs `tauri-driver` and has no macOS WebDriver), rendering consistency (bundled Chromium vs WebView2/WKWebView), security model, installer size, auto-update, SQLite access, how native the UI must feel (selection, cursors, focus, window chrome, context menus). Must also pin the Node version and package manager (pnpm is installed). Present the recommendation to Sirui in Chinese; he approves.
4. **ADR-0002: Data storage** — accepted 2026-09-26: synced metadata as JSON in `.folio/`, a derived SQLite catalog via rusqlite, and a custom FTS5 tokenizer for Chinese (`docs/adr/ADR-0002-data-storage.md`).
5. **ADR-0003: Versioning and sync format** — accepted 2026-09-26: a custom content-addressed store (BLAKE3, immutable packs), per-device head records in iCloud Drive, import-before-overwrite mirror rules (`docs/adr/ADR-0003-versioning-and-sync.md`). Original brief: local history plus push/pull through a folder in iCloud Drive: Git vs a custom format, a remote layout that survives iCloud's lack of locking (append-only history, plain browsable file tree), full versions for text and Word files vs change events only for other files, conflict handling. Constraints: `docs/product/brief.md` §12.
6. **Design foundation** — done 2026-09-27 (Cowork, lane `design/design-foundation-v1`): tokens in `design/tokens/` (light and dark; `README.md` has naming, modes and the contrast table), the build spec `docs/design/handoff/app-shell.md`, brief v0.3, and two private Cowork artifacts: the Design canvas "Folio 设计基础" and the Design System "Folio Design System" (links in the handoff spec). New screens start from them.
7. **Scaffold** — started 2026-09-26 (lane `chore/build-scaffold`), ahead of milestone 6 with Sirui's go-ahead: workspaces, placeholder UI, typed IPC, Playwright e2e over WebView2 CDP, CI on Windows (GitHub Actions). Run `pnpm check` and `pnpm e2e` before asking to land (`docs/specs/testing-strategy.md`).

### Directory map

```
.claude/settings.json  shared Claude Code settings: attribution off, git-write deny rules
.editorconfig          UTF-8, LF, final newline
.gitattributes         eol=lf; CRLF for *.cmd/*.bat; binary assets
.gitignore
.github/workflows/     ci.yml: `pnpm check` + `pnpm e2e` on windows-2022; commits.yml: commit identity, every push to main
scripts/               repository checks run by `pnpm check` (check-commits.mjs)
Cargo.toml             Rust workspace (edition 2024); Cargo.lock pins the Tauri family
rust-toolchain.toml    Rust toolchain with rustfmt and clippy
package.json           root scripts: dev, check, e2e, bundle
pnpm-workspace.yaml    apps/*, e2e; engineStrict; catalog of shared versions
tsconfig.base.json     compiler options shared by the TypeScript packages
.nvmrc                 Node version
crates/
  folio-core/          core library: no Tauri, UI or IPC types (ADR-0001)
  folio-app/           Tauri shell: commands, IPC contract (src/ipc.rs), capabilities/, tauri.conf.json, icons/
apps/
  desktop/             React + TypeScript UI (Vite); src/ by feature folder (docs/specs/ui-architecture.md §4, import rules in eslint.config.js):
                       app/ = window shell, stores, registry of views, dialogs and toolbar controls; components/ = shared components (React Aria);
                       lib/ = pure helpers; data/ = query cache; ipc/ = only IPC entry (mock/ = fake shell for the browser pane); titlebar/;
                       one folder per view (library/, search/, preview/, …); i18n/ = UI strings (en); tokens/ = CSS and TS constants
                       generated from design/tokens; gallery.html = dev-only gallery of the shell and components
e2e/                   Playwright over WebView2 CDP (fixtures.ts starts the app per test)
docs/
  agents/              agent reference docs, e.g. skill-routing.md   (English)
  adr/                 ADR-NNNN-<slug>.md                            (English)
  product/             product brief, roadmap                         (Chinese, for Sirui)
  roadmap/             roadmap.json (live lane state), `pnpm roadmap` CLI, explorer page (README: English)
  research/            research plans and synthesis                   (Chinese, for Sirui)
  specs/               feature specs for agents                       (English)
  design/handoff/      design-handoff specs                           (English)
design/
  tokens/              design-token source of truth
.agents/lanes/         live lane files (git-ignored, see §7.3)
.agents/locks/         shared runtime locks, e.g. the app lock (git-ignored, see §7.5)
.agents/work/          retired work packages, a read-only archive (git-ignored, see §7.7)
CLAUDE.md
```

---

## 7. Version control: GitButler parallel lanes

This repo runs in **GitButler workspace mode** (target `origin/main`): many branches are
applied to one working directory at the same time. Each parallel session works on its own
branch ("lane"). GitButler provides branch isolation, **not runtime isolation** — all
sessions share the same files on disk, dependency install, dev server, build output and
app data.

Command syntax comes from the installed `gitbutler` skill (`~/.claude/skills/gitbutler`,
versioned with the `but` CLI). This section sets project policy and does not restate
syntax. On syntax, the skill wins; on policy, this section wins.

### 7.1 Hard rules

1. Use the `but` CLI for **every** Git write. Never run `git add`, `git commit`, `git push`, `git pull`, `git checkout`, `git switch`, `git merge`, `git rebase`, `git stash`, `git reset`, `git restore`, `git revert` or `git cherry-pick`. `.claude/settings.json` denies these for the Bash and PowerShell tools; never work around the deny (`git -C`, `sh -c`, aliases). Read-only `git log` / `git show` / `git blame` / `git diff` are fine.
2. Never invent IDs or flags. Copy file, hunk, commit and branch IDs from the latest `but status -fv` or `but diff`. IDs are space-separated positional arguments. Check `but <command> --help` when the skill does not cover a case.
3. Always pass `-m "<message>"`; no editor opens in agent sessions.
4. Do not configure the old `but claude pre-tool/post-tool/stop` hooks (removed in GitButler 0.20), even if older docs suggest them.
5. **Commits are Sirui's; no agent information in history.** Author and committer are `Sirui Mei <sirui.mei07@gmail.com>` (the global Git identity on every device; Sirui, 2026-10-02). No agent — Claude Code, Codex, Cowork or any other — adds its name, model, session, link, co-author or other credit trailer (`Co-Authored-By:`, `Signed-off-by:`, `Claude-Session:`, "Generated with …", 🤖) to a commit message, whatever the harness default says. Enforced by `attribution` in `.claude/settings.json` (keep it empty) and by `scripts/check-commits.mjs`: `pnpm check` checks the commits not yet on `origin/main`, and the `Commits` workflow checks the whole history on every push to main (an edit Sirui makes on github.com, committed by `GitHub <noreply@github.com>`, passes). A failing commit that is not pushed yet gets `but reword`, or `but uncommit` and a new commit.
6. Landing on `main` (`but land`, which pushes to `origin`) and any other push happen only after Sirui explicitly approves in the current conversation. Pull requests are not used.
7. Do not use GitButler's `--ai` options (e.g. `but resolve --ai`). GitButler's AI provider on this machine is OpenAI, so they send repository content to a third party. Resolve conflicts yourself.

### 7.2 Branch naming and commits

- Branch: `<type>/<area>-<short-kebab-desc>`
  - type: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `design`, `chore`, `spike`
  - area = ownership zone: `ui`, `core` (privileged process), `data`, `ipc`, `design`, `docs`, `build`
  - e.g. `feat/core-document-import`, `design/design-tokens-v1`, `docs/adr-0001-stack`
- Commits: Conventional Commits in English (`feat(core): add import queue`), one logical change each, tests in the same commit as the behaviour they verify.
- Checkpoint commit when a sub-task is complete and its checks pass (or failures are reported).

### 7.3 Lane protocol

**Lane file.** Every active session owns one file at `.agents/lanes/<branch-name-with-/-replaced-by-->.md`
(git-ignored, but visible to every session because the working directory is shared):

```md
# Lane: feat/core-document-import
- Agent: Claude Code | Cowork — started <YYYY-MM-DD HH:MM>
- Goal: <one sentence>
- Owns: src/core/import/**, src/shared/ipc/import.ts
- Shared files touched (additive hunks only): package.json
- Stacked on: — | <parent branch>
- Status: planning | editing | checkpoint | review | done
- Updated: <YYYY-MM-DD HH:MM>
```

**Start**
1. `but status` and `but pull --check`. Read every file in `.agents/lanes/`. `pnpm roadmap next` shows the landing queue, the active lanes and what can start; `pnpm roadmap show <lane>` shows your lane's dependencies, paths and prompt.
2. Choose paths to own. They must not overlap another active lane's `Owns`. On overlap: if your work depends on that lane, stack on it (below); otherwise stop and ask Sirui in Chinese.
3. Write your lane file, then create the branch: `but branch new <name>` — or let the first `but commit -b <name>` create it.

**Work**
4. Edit only owned paths. Shared hot spots — package manifest and lockfile, root configs, token source, IPC contract index, router/route table, i18n base file, `CLAUDE.md`, `.claude/settings.json` — get small additive edits only; never reformat or reorder a shared file.
5. Dependency installs change the shared lockfile and `node_modules`: do them in a dedicated `chore/build-deps-<desc>` lane or as an exclusive operation (7.4).
6. Keep the lane file's `Status` and `Updated` current, and your lane's entry in `docs/roadmap/roadmap.json` (the roadmap's only live state): `pnpm roadmap status <lane> wip` at the start, `pnpm roadmap gate` as checks finish, `review` with the report, and `done` in the lane's last commit right before `but land`. Change only your own entry; `docs/roadmap/README.md` has the commands. `pnpm check` validates the file.

**Commit**
7. `but status -fv` (or `but diff`) → commit **only your own files or hunks**: `but commit -b <branch> -m "<msg>" <id> <id>`. If a file contains another lane's hunks, commit by hunk ID. Never commit, amend, discard or move another lane's changes.
8. Fold small fixes into your own unpublished commits with `but absorb` / `but amend`.

**Dependencies between lanes**
9. Independent work → parallel branches (default).
10. Work that needs another lane's unlanded code → stack it: `but branch new <name> --above <parent>`, or move an existing branch with `but move <branch> --above <parent>`. Record `Stacked on` in the lane file.
11. **Contract first.** When a feature spans UI and core, create a small `feat/ipc-<feature>-contract` lane with the shared types; land it first, then run the UI and core lanes in parallel on top of `main`. If it cannot land first, stack core on the contract lane and UI on core.

**Finish**
12. Squash the lane into one commit before it lands, so main keeps one commit per lane (Sirui, 2026-10-07): `but oplog snapshot` first, then `but squash` the branch's commits into one whose subject names the lane's outcome and whose body says what it delivered (`but reword` for the message). Rewrite history on your own branch only.
13. Set lane `Status: review` and report to Sirui in Chinese: branch name, what changed, checks run, open risks.
14. After approval: `but land <branch> --yes` (an exclusive operation, 7.4). It fast-forwards `origin/main` when possible, pushes it, and reconciles the other applied branches like `but pull`. For a stack, name the top branch and add `--whole-stack`. A land cannot be undone with `but undo`; fix mistakes with a new commit.
15. After landing: confirm with `but status` that the branch is gone, then delete your lane file.

### 7.4 Exclusive (workspace-wide) operations

These affect every lane. Run them only when every other lane's status is `checkpoint`, `review` or `done`, or with Sirui's go-ahead:
`but land`, `but pull`, `but undo` / `but redo`, `but oplog restore`, `but clean`, `but apply` / `but unapply` of someone else's branch, `but setup` / `but teardown`, dependency installs, formatter runs over the whole repo, database resets.

`but undo` reverts the **last workspace operation, which may belong to another session**. Check `but oplog` first; to undo your own commit prefer `but uncommit`.

### 7.5 Shared runtime

- Only one session runs the dev server; others reuse it. Record who runs it in that lane file.
- `pnpm build:app` and `pnpm e2e` replace and run `target/debug/folio-app.exe`, so only one session runs them at a time. Take the app lock first (`mkdir` fails while another session holds it) and always release it; a lock older than an hour: ask Sirui instead of breaking it. Timing runs hold it too and start only when no other `cargo` or `pnpm` process runs: the lock does not stop other sessions' `pnpm check`.
  ```bash
  mkdir -p .agents/locks && mkdir .agents/locks/app && echo "<branch> $(date '+%F %T')" > .agents/locks/app/owner
  pnpm e2e
  rm -rf .agents/locks/app
  ```
- Tests that write data use a per-lane temporary data directory (env var set per lane), never the shared dev database.
- If two tasks need incompatible states (framework upgrade, competing prototypes, different build flags), GitButler parallel branches are the wrong tool — ask Sirui before using a separate worktree.

### 7.6 Roles

| Participant | Does | Never |
|---|---|---|
| Claude Code session (one per lane) | Implements, tests, commits its lane with `but` | Touches paths owned by another lane; runs exclusive ops without clearance |
| Cowork session | Design canvas, Design System artifact, specs, research, Chinese docs for Sirui; writes files only under `docs/` and `design/` | Runs `git` or `but` (its shell is a Linux VM without GitButler); edits `src/` |
| Sirui | Approves ADRs, designs and merges; reviews lanes in `but gui` / `but tui` | — |

Cowork hand-off: Cowork writes its files, creates a lane file with `Agent: Cowork` and
`Status: review`, and leaves the changes uncommitted. The next Claude Code session (or
Sirui) commits them with `but commit -b docs/<desc> -m "<msg>" <ids>` or `design/<desc>`.

### 7.7 Work packages (retired)

Since 2026-09-27 work is not split into packages for other sessions to claim. Plan lanes
instead: a branch name and a short start prompt for each session Sirui opens himself (as in
the roadmap's appendix A). Each lane reports to Sirui and updates its own ADR lines.
`.agents/work/` keeps the finished packages WP-01 to WP-04 as a read-only archive: do not
claim, add or update packages there.

---

## 8. Definition of done (every lane)

Check every item that applies; a docs or ADR lane skips the UI and backend items.

- [ ] Typecheck, lint and tests pass; new behaviour has tests.
- [ ] UI: matches the handoff spec; `design:design-critique` and `design:accessibility-review` passed; reduced-motion verified; Playwright flow for new user-facing flows.
- [ ] No hard-coded visual values or UI strings.
- [ ] `engineering:code-review` (or `/code-review`) done: no swallowed errors, new or changed types reviewed.
- [ ] Backend/IPC: inputs validated on the privileged side; `/security-review` findings resolved.
- [ ] `/simplify` pass done; no duplicated pattern introduced.
- [ ] ADR written for any costly-to-reverse decision.
- [ ] Roadmap entry current (`pnpm roadmap status`), and `done` committed on the lane right before landing.
- [ ] Commits on the lane branch only, squashed into one before landing (§7.3 rule 12), Conventional Commits, authored as Sirui with no agent information (§7.1 rule 5, `pnpm check`).
- [ ] Chinese summary sent to Sirui.

---

## 9. Bootstrap and environment

### 9.1 Done (2026-09-26)

- Git repo in `Folio/` with remote `origin` = `https://github.com/siruimei07/Folio.git` (private).
- Initial commit on `main` made and pushed with plain Git — the only sanctioned plain-Git writes — then `but setup` (target `origin/main`).
- GitButler skill installed globally (`~/.claude/skills/gitbutler`, v0.22.3, matches the CLI). GitButler forge auth: GitHub OAuth, valid. After upgrading GitButler, run `but skill check --update`.
- Git identity (global): Sirui Mei <sirui.mei07@gmail.com>.
- Merge method: `but land` straight onto `origin/main`; no pull requests.
- Skills in use: exactly those in `docs/agents/skill-routing.md` (Claude account plugins `design:*`, `engineering:*`, `data:*`, `frontend-design`; skills `dataviz`, `gitbutler`; Claude Code built-ins). No further skills or plugins are installed for now.

### 9.2 To do (Sirui, optional)

- [x] `git config --global core.quotepath false` so Git prints Chinese file names readably (set on DESKTOP-N7UG6S7, 2026-10-02).
- [ ] Disable the unrelated `finance` plugin on the Claude account to shorten the skill list.
