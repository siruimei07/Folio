# Folio 上线路线图（到 v1.0）

> **状态**：v0.6，M1 第 3 波：4 个 lane 待评审和合并 · **更新**：2026-10-01 · **决策人**：Sirui · **整理**：Claude Code
>
> 每到一个同步点就更新本文。**图例**：✅ 已完成 · 🔄 进行中 · 🟡 做完了，待评审或合并 · 🟢 可以开始 · ⏳ 排队（依赖已满足，等 Rust 名额） · 🔒 未解锁（依赖还没合并）

## 1. 现在在哪

- **M1 第 3 波**（2026-10-01 早上）。开工的 4 个 lane 都做完了，停在 review，还没有合并：导入和 WebView 快捷键（Codex）要先由 Claude Code 评审；资料库视图和本机设置（Claude Code）只等你批准合并。本机设置和快捷键 lane 的改动还没提交（`lib.rs` 里有一处挨在一起的改动），要快捷键先提交。
- **下一步（同步点 3）**：用 §2 里这 4 行的提示词评审并合并，一次合并一个：WebView 快捷键 → 本机设置 → 导入 → 资料库视图，再合并本路线图。合并完，导入界面和设置界面解锁，放弃未完成的移动也可以开。
- **同时可以开**：预览、`Ctrl+K` 搜索、首次使用 3 个前端 lane，和 STA 辅助函数合并（现在没有 lane 在写 Rust）。
- **还剩多少**：M1 还有 11 个 lane（4 个待评审或合并、4 个可以开始、1 个排队、2 个未解锁）加 M1 验收；之后 M2 约 14 个、M3 约 15 个、M4 约 6 个。
- **需要你**：批准同步点 3 的 4 次合并（提示词里已写好）；有空时把 iCloud for Windows 升到 Microsoft Store 的当前版本（M3 前要用）。完整清单见 §6。

## 2. 任务看板：M1 第 3、4 波

前端 lane 各占一个 `apps/desktop/src/<视图>/` 目录，同时开 4 个没问题；写 Rust 的 session 最多 3 个（CLAUDE.md §7、本文 §4 第 6 条）。`pnpm e2e` 一次只能一个 session 跑，先拿 app lock（CLAUDE.md §7.5）。

<table>
<thead>
<tr><th>状态</th><th>Lane</th><th>谁</th><th>做什么</th><th>提示词</th></tr>
</thead>
<tbody>

<tr>
<td>🟡</td>
<td><code>feat/core-import</code><br>后端 · M</td>
<td>Codex</td>
<td>M1 最后 3 个命令：选择文件、原生拖放、<code>check_import</code>、带进度的导入任务、同名处理、可选把原文件移进回收站</td>
<td>

<details><summary>评审并合并的提示词</summary>

```text
Folio: review and land the Codex lane feat/core-import (docs/product/roadmap.md §2). I approve landing it once your reviews pass and the checks are green.
1. Read CLAUDE.md, every file in .agents/lanes/, .agents/lanes/feat--core-import.md and the review scope in ../folio-agent-work/tasks/feat-core-import/ (claude-review-handoff.md, or the verification notes there). Run `but status` and `but pull --check`.
2. Take over the lane for review: /code-review, /security-review and /simplify on its commits, following the handoff's focus list. Fix findings with commits on the branch; stop and ask me if a finding needs a product or security decision.
3. Take the app lock (CLAUDE.md §7.5), run `pnpm check` and `pnpm e2e`, release the lock.
4. If the lane has not, add its progress line to the ADR and spec items it finishes (for commands: ADR-0004 action item 3 and docs/specs/ipc-m1.md §21).
5. Land one lane at a time: check that no other lane is landing, then `but land feat/core-import --yes`, `but status`, delete the lane file and check the CI run on main. Stop at the first conflict or failure and report it; never use --ai.
Report to me in Chinese.
```

</details>

</td>
</tr>

<tr>
<td>🟡</td>
<td><code>chore/core-webview-accelerator-keys</code><br>后端 · S</td>
<td>Codex</td>
<td>正式版关掉 WebView2 的浏览器快捷键（刷新、查找、打印）</td>
<td>

<details><summary>评审并合并的提示词</summary>

```text
Folio: review and land the Codex lane chore/core-webview-accelerator-keys (docs/product/roadmap.md §2). I approve landing it once your reviews pass and the checks are green.
1. Read CLAUDE.md, every file in .agents/lanes/, .agents/lanes/chore--core-webview-accelerator-keys.md and the review scope in ../folio-agent-work/tasks/chore-core-webview-accelerator-keys/ (claude-review-handoff.md, or the verification notes there). Run `but status` and `but pull --check`. The lane's changes may still be uncommitted (crates/folio-app/src/webview_settings.rs and its `build_main` line in lib.rs, which shares a hunk with feat/core-app-settings): commit only this lane's files and hunks first, by hunk ID.
2. Take over the lane for review: /code-review, /security-review and /simplify on its commits, following the handoff's focus list. Fix findings with commits on the branch; stop and ask me if a finding needs a product or security decision.
3. Take the app lock (CLAUDE.md §7.5), run `pnpm check` and `pnpm e2e`, release the lock.
4. If the lane has not, add its progress line to the ADR and spec items it finishes (for commands: ADR-0004 action item 3 and docs/specs/ipc-m1.md §21).
5. Land one lane at a time: check that no other lane is landing, then `but land chore/core-webview-accelerator-keys --yes`, `but status`, delete the lane file and check the CI run on main. Stop at the first conflict or failure and report it; never use --ai.
Report to me in Chinese.
```

</details>

</td>
</tr>

<tr>
<td>🟡</td>
<td><code>feat/ui-library-view</code><br>前端 · L</td>
<td>Claude Code</td>
<td>资料库视图：课程树、标签筛选、最近添加和未打标签、列表 / 网格、新建文件夹、重命名 / 移动 / 删除、批量打标签、右键菜单</td>
<td>

<details><summary>合并的提示词</summary>

```text
Folio: land feat/ui-library-view (docs/product/roadmap.md §2). I approve landing it.
1. Read CLAUDE.md §7, every file in .agents/lanes/ and .agents/lanes/feat--ui-library-view.md; run `but status` and `but pull --check`.
2. Confirm from the lane file that /code-review, /security-review where it applies, and /simplify are done; if one is missing, run it and fix findings with commits on the branch.
3. Take the app lock (CLAUDE.md §7.5), run `pnpm check` and `pnpm e2e`, release the lock.
4. Land one lane at a time: check that no other lane is landing, then `but land feat/ui-library-view --yes`, `but status`, delete the lane file and check the CI run on main. Stop at the first conflict or failure and report it; never use --ai.
Report to me in Chinese.
```

</details>

</td>
</tr>

<tr>
<td>🟡</td>
<td><code>feat/core-app-settings</code><br>后端（含合约）· S</td>
<td>Claude Code</td>
<td>本机设置：设备名、外观、减少动态效果、忽略规则</td>
<td>

<details><summary>合并的提示词</summary>

```text
Folio: land feat/core-app-settings (docs/product/roadmap.md §2). I approve landing it.
1. Read CLAUDE.md §7, every file in .agents/lanes/ and .agents/lanes/feat--core-app-settings.md; run `but status` and `but pull --check`. Its changes are uncommitted: wait until chore/core-webview-accelerator-keys has committed its `build_main` line in crates/folio-app/src/lib.rs, then commit only this lane's files and hunks (the lane file lists them) on feat/core-app-settings.
2. Confirm from the lane file that /code-review, /security-review where it applies, and /simplify are done; if one is missing, run it and fix findings with commits on the branch.
3. Take the app lock (CLAUDE.md §7.5), run `pnpm check` and `pnpm e2e`, release the lock.
4. Land one lane at a time: check that no other lane is landing, then `but land feat/core-app-settings --yes`, `but status`, delete the lane file and check the CI run on main. Stop at the first conflict or failure and report it; never use --ai.
Report to me in Chinese.
```

</details>

</td>
</tr>

<tr>
<td>🟢</td>
<td><code>feat/ui-preview</code><br>前端 · L</td>
<td>Claude Code</td>
<td>预览区：图片、PDF、Markdown（公式、代码高亮、笔记旁边的图片）、代码、音视频、其他；Office 先显示「用默认程序打开」；预览沙箱的 CSP 小改（要 <code>/security-review</code>）</td>
<td>

<details><summary>提示词</summary>

```text
Folio lane feat/ui-preview (docs/product/roadmap.md §2, M1 wave 3). What it builds on is on main: the data hooks in apps/desktop/src/data/, browse with resolve_paths, and the folio-file scheme. Use frontend-design.
Read docs/specs/ui-architecture.md §10 (where each type renders, the frame, the protocol, the renderers, keyboard and focus), §14, §17 items 1 and 2 and §18; ADR-0005 (product decisions 1 and 2); ADR-0001 action items 4c and 5 (the Office choice, the preview sandbox); docs/design/handoff/app-shell.md §5 (the preview pane) and library-actions.md §9.2–§9.3; docs/specs/ipc-m1.md §11 with the failure reasons of the contract fix.
Goal: the preview pane: images, PDF with pdf.js, Markdown with maths, code highlighting, sanitised HTML and images next to the note (resolve_paths), code and plain text, audio and video, and the card for other files; links show their address and can be copied, never opened; the header with tags and the Open and Show in File Explorer actions; one fresh frame per file; the frame protocol. Office files show the "Open with default app" card in M1 (their renderers come with feat/ui-office-preview in M4). Settle ui-architecture §17 items 1 and 2 (the pdf.js worker in the sandboxed frame, Temml on real notes) and check HEIC. feat/ui-library-view is being built at the same time and hosts this pane in its third column: export the pane as one component with a small prop interface and note it in your lane file.
Add `worker-src blob:` and `'wasm-unsafe-eval'` to the preview CSP in crates/folio-app/src/preview.rs and nowhere else; the preview-sandbox e2e tests must still pass, and that change gets /security-review. Own apps/desktop/src/preview/** (move src/preview/frame.ts into src/preview/frame/), preview.rs and the preview namespace. Component tests, a Playwright flow per renderer family, design:design-critique and design:accessibility-review, a reduced-motion check, `pnpm check` and `pnpm e2e` with the app lock (CLAUDE.md §7.5), /code-review, /security-review, /simplify; report to me in Chinese.
```

</details>

</td>
</tr>

<tr>
<td>🟢</td>
<td><code>feat/ui-search-palette</code><br>前端 · M</td>
<td>Claude Code</td>
<td><code>Ctrl+K</code> 搜索：输入即出结果、分组、高亮只当文本渲染、方向键和回车（在资料库里选中并预览）</td>
<td>

<details><summary>提示词</summary>

```text
Folio lane feat/ui-search-palette (docs/product/roadmap.md §2, M1 wave 3). What it builds on is on main: the data hooks in apps/desktop/src/data/ (search.ts) and the browse commands. Use frontend-design.
Read docs/design/handoff/app-shell.md §8 (search), docs/specs/ui-architecture.md §9 and §14, docs/specs/ipc-m1.md §10, the browse hand-off ../folio-agent-work/tasks/feat-data-browse-queries/frontend-handoff.md (the fixed 500-result window, QueryTooLong, plain-text spans), and apps/desktop/src/app/registry.ts and navigation.ts (registering the search dialog shows the toolbar button and Ctrl+K).
Goal: the Ctrl+K palette: results as you type, grouped, highlights rendered as text from the spans (never innerHTML), arrow keys, Enter selecting the file in the Library view and opening its preview through the navigation store, Escape, and the empty, too-long and error states. feat/ui-library-view and feat/ui-preview are being built at the same time: go through the navigation store, not their components.
Own apps/desktop/src/search/** and the search namespace; app/registry.ts gets a one-line edit. Component tests, a Playwright flow, keyboard and screen-reader checks with design:accessibility-review, design:design-critique, a reduced-motion check, `pnpm check` and `pnpm e2e` with the app lock (CLAUDE.md §7.5), /code-review, /simplify; report to me in Chinese.
```

</details>

</td>
</tr>

<tr>
<td>🟢</td>
<td><code>feat/ui-first-run</code><br>前端 · M</td>
<td>Claude Code</td>
<td>欢迎页 → 新建或接管资料库 → 第一个学期和课程；资料库打不开时的界面和重试；手动点一次原生选文件夹对话框</td>
<td>

<details><summary>提示词</summary>

```text
Folio lane feat/ui-first-run (docs/product/roadmap.md §2, M1 wave 3). What it builds on is on main: the data hooks in apps/desktop/src/data/ (library choices, groups) and the library and operations commands. Use frontend-design.
Read docs/design/handoff/first-run.md (all of it), library-actions.md §2 (shared components), docs/specs/library-state.md, docs/specs/ipc-m1.md §6 and §7 (library states, incomplete libraries, the unavailable reasons and the retry) and docs/specs/ui-architecture.md §6.1 (the current semester per library).
Goal: the first-run flow the app shows while library_status has no library: welcome, choosing a folder (new library or taking over one), the library name, the first semester and courses with row-by-row failures (first-run.md §5), and the library-unavailable screen with Try again. Drive the native folder dialog by hand once in the real app (no lane has yet) and note the result in your lane file. If feat/core-discard-move has landed, the library-unavailable screen also offers its confirmed "discard the unfinished move" action for the reason it adds (copy with design:ux-copy); if not, note it in your lane file as open.
Own apps/desktop/src/first-run/** and the first-run namespace; app/ gets small additive edits to show the flow. Component tests for every state first-run.md names, a Playwright flow in a temporary folder, design:design-critique and design:accessibility-review, a reduced-motion check, `pnpm check` and `pnpm e2e` with the app lock (CLAUDE.md §7.5), /code-review, /simplify; report to me in Chinese.
```

</details>

</td>
</tr>

<tr>
<td>🟢</td>
<td><code>refactor/core-sta-helper</code><br>后端 · S</td>
<td>Codex</td>
<td>两个几乎一样的 STA 辅助函数合成一个，保留 CI 修复的 MTA 规则。现在没有 lane 在写 Rust，可以开</td>
<td>

<details><summary>提示词</summary>

```text
Codex: follow Documents Manage/AGENTS.md and Folio/CLAUDE.md. Backend coding only: lane file in Folio/.agents/lanes/, specs and ADRs in Folio/docs/, scratch in folio-agent-work/tasks/<lane>/. Map the Claude skill names below to your skills in AGENTS.md §5. Stop at review and write the review scope into folio-agent-work/tasks/<lane>/claude-review-handoff.md; a Claude Code session runs /code-review, /security-review and /simplify before I approve the land.

Folio lane refactor/core-sta-helper (docs/product/roadmap.md §2, M1 wave 3). Small. Start only when fewer than three sessions are building Rust (count the lane files in .agents/lanes/).
Two near-identical helpers run work on a single-threaded apartment: `in_sta` in crates/folio-app/src/dialogs.rs and `in_apartment` in folio-core's win::recycle. Keep one, in folio-core's win module, and use it from both, without changing behaviour: the CI fix's rule (docs/specs/windows-adapter.md §4: hold the process MTA so a teardown never unloads a cached WinRT factory) and the Recycle Bin's COM threading stay as they are. The commit "fix(app): keep COM initialized so cached WinRT factories stay valid" explains the rule. feat/core-import also edits the dialog code in crates/folio-app/src/library/: read its lane file and keep clear of its paths.
Own the two files and the shared helper. Tests for both callers, `pnpm check` and `pnpm e2e` with the app lock (CLAUDE.md §7.5), /code-review, /simplify; after landing, check that the CI run on main (Windows Server 2022, where the crash showed) is green. Report to me in Chinese.
```

</details>

</td>
</tr>

<tr>
<td>⏳</td>
<td><code>feat/core-discard-move</code><br>后端（含合约）· S</td>
<td>Claude Code</td>
<td>移动做到一半崩溃、之后又对不上时：打不开资料库的单独原因，加一个要确认的「放弃这次未完成的移动」命令。等 <code>feat/core-app-settings</code> 合并后再开（两个都会重新生成 bindings）</td>
<td>

<details><summary>提示词</summary>

```text
Folio lane feat/core-discard-move (docs/product/roadmap.md §2, M1 wave 3). Contract and implementation in one small lane. Start after feat/core-app-settings has landed (both regenerate the bindings and the fake shell's fingerprint) and when fewer than three sessions are building Rust. feat/core-import (Codex) edits crates/folio-core/src/library/mod.rs and docs/specs/ipc-m1.md too: read its lane file and keep your hunks there small.
Read docs/specs/library-scan.md §7.1 (the move intent and its recovery), docs/specs/library-state.md (recovery, the unavailable reasons, and Sirui's decision of 2026-09-30 on discarding an unfinished move), docs/specs/ipc-m1.md §6 and §20, ADR-0002 §1, and Library::recover_pending in crates/folio-core/src/library/mod.rs with ScanJournal in meta/tree.rs.
Goal: when the intent of an in-app move that a crash interrupted can no longer be reconciled (its files, folders or metadata changed, or the catalog was recreated), library_status says so with an unavailable reason of its own instead of catalogFailed, and a confirmed command discards the move. Discarding never moves or deletes the user's files and never overwrites an authored metadata file that no longer matches the journal's images; it removes the journal, and a full scan rebuilds the catalog from the disk and the authored metadata. Write the contract into ipc-m1 (§6 and §20), regenerate the bindings and, in the same lane, update the fake shell in apps/desktop/src/ipc/mock/ and its fingerprint (roadmap §4 rule 2). Tell feat/ui-first-run the reason and the command: the button belongs on its library-unavailable screen.
Start with engineering:system-design. Own the new command, its manifest and capability lines, and the discard function in folio-core's library module. Contract tests, crash tests (a discard interrupted halfway, a conflicting metadata file), `pnpm check` and `pnpm e2e` with the app lock (CLAUDE.md §7.5), /code-review, /security-review, /simplify; report to me in Chinese.
```

</details>

</td>
</tr>

<tr>
<td>🔒</td>
<td><code>feat/ui-import</code><br>前端 · M</td>
<td>Claude Code</td>
<td>拖放目标、「Add files」、导入对话框（标签、同名处理、删除原文件）、进度和结果</td>
<td>等 <code>feat/core-import</code> 和 <code>feat/ui-library-view</code> 合并；提示词到时补</td>
</tr>

<tr>
<td>🔒</td>
<td><code>feat/ui-settings</code><br>前端 · M</td>
<td>Claude Code</td>
<td>Library settings（学期、课程、标签、忽略规则、重建索引）和 App settings（设备名、外观、减少动态效果）</td>
<td>等 <code>feat/core-app-settings</code> 和 <code>feat/ui-library-view</code> 合并；提示词到时补</td>
</tr>

<tr>
<td>🔒</td>
<td>M1 验收</td>
<td>Claude Code</td>
<td>全部用户流程的 e2e、5 万文件性能复核、冻结 schema 和 <code>.folio</code> 格式的 fixture、<code>engineering:tech-debt</code>、未签名安装包，出 v0.1（§4）</td>
<td>等第 4 波合并</td>
</tr>

</tbody>
</table>

<details><summary>通用提示词：评审并合并一个 Codex lane（Codex lane 到 review 时用，把 &lt;branch&gt; 换成分支名）</summary>

```text
Folio: review and land the Codex lane <branch> (docs/product/roadmap.md §2). I approve landing it once your reviews pass and the checks are green.
1. Read CLAUDE.md, every file in .agents/lanes/, the lane file (the branch name with / replaced by --) and the review scope Codex wrote in ../folio-agent-work/tasks/<branch name with / replaced by ->/claude-review-handoff.md. Run `but status` and `but pull --check`.
2. Take over the lane for review: /code-review (at high effort for a large lane), /security-review and /simplify on its commits, following the handoff's focus list. Fix findings with commits on the branch; stop and ask me if a finding needs a product or security decision.
3. Take the app lock (CLAUDE.md §7.5), run `pnpm check` and `pnpm e2e`, release the lock.
4. If the lane has not, add its progress line to the ADR and spec items it finishes (for commands: ADR-0004 action item 3 and docs/specs/ipc-m1.md §21).
5. Land one lane at a time: check that no other lane is landing, then `but land <branch> --yes`, `but status`, delete the lane file and check the CI run on main. Stop at the first conflict or failure and report it; never use --ai.
Report to me in Chinese.
```

</details>

## 3. 进度

### 3.1 已完成的 lane

<details><summary>✅ 已完成：阶段 0、第 1 波、同步点 1、第 2 波、同步点 2（2026-09-28 ～ 10-01，点开看）</summary>

| 阶段 | Lane | 谁 | 内容 |
|---|---|---|---|
| 阶段 0 | `fix/core-snap-overlay-edges` | Claude Code | 贴靠按钮不挡顶部缩放边；读屏软件看不到覆盖层 |
| 阶段 0 | `feat/core-windows-fs` → `-recycle-bin` → `-watcher` | Claude Code | NTFS 文件 ID 和占位文件；只进回收站；文件监视和局部重扫 |
| 阶段 0 | `feat/ipc-m1-contract` | Claude Code | M1 IPC 合约，ADR-0004 |
| 阶段 0 | `design/design-foundation-v1` → `feat/ui-token-css` | Cowork、Claude Code | 设计 token、app-shell handoff、brief v0.3；从 token 生成 CSS |
| 阶段 0 | `chore/build-deps-tauri-2-12` | Codex | Tauri 2.12 |
| 阶段 0 | 路线图、退役工作包 | Claude Code | 本文第一版；`.agents/work/` 只读存档，app lock 移到 `.agents/locks/` |
| 第 1 波 | `feat/core-library-state` | Codex | 命令按功能组注册；`LibraryState`、任务、启动扫描、监视 → `CatalogChanged`、安全关窗；8 个命令 |
| 第 1 波 | `docs/adr-0005-ui-architecture` | Claude Code | 界面架构 ADR-0005 和 ui-architecture spec |
| 第 1 波 | `feat/ui-i18n-english` | Claude Code | 英文界面，每个视图一个 namespace |
| 第 1 波 | `spike/ui-office-preview` | Claude Code | Office 预览对比；PPT 选方案 A |
| 第 1 波 | `design/design-m1-flows` | Cowork | 首次使用、资料库操作两份 handoff |
| 同步点 1 | `chore/build-deps-ui-m1` | Claude Code | 装 M1 界面依赖 |
| 第 2 波 | `feat/ipc-m1-contract-fixes` | Claude Code | `resolve_paths`、`log_ui_error` 和设计交接里的合约缺口 |
| 第 2 波 | `feat/core-file-scheme` | Codex | 只读的 `folio-file` 协议、缩略图、打开和在资源管理器中显示 |
| 第 2 波 | `feat/ui-app-shell` | Claude Code | 窗口骨架、共用组件、ESLint 规则 |
| 第 2 波 | `feat/ui-data-layer` | Claude Code | TanStack Query 数据层、假 shell |
| 同步点 2 | `fix/build-ci-access-violation` | Claude Code | 修 CI 上的 `STATUS_ACCESS_VIOLATION`，main 恢复绿色 |
| 同步点 2 | `chore/core-logging` | Codex | 日志按天轮转、`log_ui_error` |
| 同步点 2 | `feat/core-library-ops` | Codex | 学期、课程、标签、条目的 18 个命令；元数据格式 2；移动的崩溃恢复 |
| 同步点 2 | `feat/data-browse-queries` | Codex | 浏览、搜索、`resolve_paths` 的 5 个命令 |
| 同步点 2 | `feat/ui-data-m1-hooks` | Claude Code | 视图共用的数据层 hook |

</details>

### 3.2 main 上已经有什么

<details><summary>main 上已经有什么（2026-10-01，137 个提交，CI 通过）</summary>

| 方面 | 内容 |
|---|---|
| 产品与决策 | brief v0.3；ADR-0001～0005 均已接受；system overview、testing strategy、ui-architecture、library-state 等 spec |
| 工程底座 | Tauri 2.12 + React 19 + Rust；类型化 IPC；Playwright 通过 WebView2 CDP 跑 e2e；GitHub Actions CI（windows-2022） |
| 核心库 | 路径和 Windows 命名规则；`.folio/` 元数据（格式 2）；SQLite catalog（迁移 2）；中文搜索；扫描与对账；移动的崩溃恢复 |
| Windows 适配 | NTFS 文件 ID、占位文件、回收站、文件监视 |
| 命令 | 资料库和任务 8 个、学期课程标签条目 18 个、浏览和搜索 5 个、`log_ui_error`；只剩导入的 3 个 |
| 文件协议 | 只读的 `folio-file`、缩略图、用默认程序打开、在资源管理器中显示 |
| 界面 | 英文界面；窗口骨架和共用组件；数据层和全部 M1 hook；假 shell（含 5 万条的数据） |
| 设计 | token（浅色和深色）；app-shell、首次使用、资料库操作三份 handoff |

</details>

### 3.3 M1 验收（出 v0.1 之前）🔒

- 每个用户流程都有 Playwright e2e；每个新界面都过了 `design:design-critique` 和 `design:accessibility-review`，并检查过减少动态效果。
- 在 5 万文件的资料库上：一页 200 行 < 50 ms，搜索一页 < 100 ms，常见文件 1 秒内出预览（browse 已测到 43 ms 和 64 ms）。
- 冻结 catalog schema 和 `.folio` 格式的 fixture（ADR-0002 行动项 5）：从此每次改格式都带迁移和测试。
- 过一遍 `engineering:tech-debt`；打一个未签名的 NSIS 安装包给你自己，先在资料库的**副本**上用一两周。

### 3.4 零散待办和去向

<details><summary>零散待办和去向</summary>

| 状态 | 待办 | 去向 |
|---|---|---|
| ✅ | Tauri 2.11 → 2.12 | `chore/build-deps-tauri-2-12` |
| ✅ | 合约缺口：导入列表的文件夹、回收站不可用的错误码、预览失败原因、启动时重试、界面错误写日志 | `feat/ipc-m1-contract-fixes` |
| ✅ | 日志按天轮转 | `chore/core-logging` |
| ✅ | 窗口命令失败的界面错误状态；`data-theme` 和首帧不闪白 | `feat/ui-app-shell` |
| ✅ | 关窗时安全收尾后台任务 | `feat/core-library-state` |
| ✅ | 课程编号等元数据修订（ADR-0002、library-core） | `feat/core-library-ops` |
| ✅ | main 的 CI 崩溃 | `fix/build-ci-access-violation` |
| ✅ | 视图共用的数据层 hook | `feat/ui-data-m1-hooks` |
| 🔄 | 学期和资料库根目录下零散文件的位置 | `feat/ui-library-view`（browse 已支持） |
| 🔄 | 正式版的浏览器快捷键 | `chore/core-webview-accelerator-keys` |
| 🟢 | 搜索高亮只能当文本渲染 | `feat/ui-search-palette` |
| 🟢 | 原生选文件夹对话框还没手动点过 | `feat/ui-first-run` |
| ⏳ | 两个重复的 STA 辅助函数 | `refactor/core-sta-helper` |
| ⏳ | 移动做到一半崩溃后对不上，资料库打不开（你 9-30 批准加「放弃」入口） | `feat/core-discard-move`，按钮在 `feat/ui-first-run` |
| 🔒 | 设置里切换外观和减少动态效果 | `feat/ui-settings` |
| 🔒 | 第一个发布的 schema 的 fixture | M1 验收 |
| 🔒 | 窗口对所有事件都有 `core:event:allow-listen`，要收窄 | M4 `test/build-release-candidate` |
| 🔒 | Windows 10、缩放比例不同的多显示器 | M4 `test/build-release-candidate` |
| 🔒 | 哈希时每个文件打开三次等性能改进 | M4 性能复核 |

</details>

## 4. 用 GitButler 排任务的规则

<details><summary>用 GitButler 排任务的 10 条规则</summary>

来自 CLAUDE.md §7 和这几天的实际情况。

1. **先合并，再开新 lane。** review 完的 lane 尽快 land。工作区里同时应用的分支越多，GitButler 的 hunk 依赖和冲突越多。
2. **合约先行。** 每个里程碑先有一个合约 lane 定下命令和类型并 land；之后核心 lane 和界面 lane 在 main 上并行，界面用假 shell 开发，不等核心。实现 lane 不改合约；确实要改，就开一个小的合约修正 lane 先合并。合约 lane 重新生成 bindings 时，在同一个 lane 里更新假 shell（`apps/desktop/src/ipc/mock/`）和它的指纹。同一时间只让一个 lane 重新生成 bindings。
3. **stack 只给真实依赖，最多两层。** 能等上游 land 再开的就不要 stack。只改文档、一起合并的 stack 例外。
4. **按目录分所有权。** 核心 lane 拥有 `crates/folio-core/src/<模块>/**`，shell lane 拥有 `crates/folio-app/src/commands/<组>` 等，界面 lane 拥有 `apps/desktop/src/<视图>/**`。
5. **拆开热点文件。** 命令按功能组注册（各组自己的清单和 capability 文件）；界面文案按视图分 namespace；视图注册到 `app/registry.ts` 只改一行；依赖由 `chore/build-deps-*` lane 集中装（独占操作）。
6. **并行上限。** 写 Rust 的 session 最多 3 个（Claude Code 和 Codex 合计）；界面 session 按目录分开可以开到 4 个；另加 Cowork。所有 session 共用一个 `target/` 和一个 dev server，`pnpm e2e` 用 app lock 排队。
7. **独占操作放在同步点。** `but land`、`but pull`、装依赖都要在其他 lane 是 `checkpoint`、`review` 或 `done` 时做。
8. **每个 lane 同样收尾。** `pnpm check` + `pnpm e2e` → `/code-review`（特权层或 IPC 再加 `/security-review`）→ `/simplify` → 用中文汇报 → 你批准 → `but land` → `but status` → 删 lane 文件。
9. **CI 红了先修。** main 的 CI 失败时先合并修复，再合并别的。9-29 到 9-30 CI 红了两天，期间合并的 6 个 lane 都没有 CI 把关。
10. **Codex lane 一到 review 就评审。** 用 §2 下面的通用评审提示词开一个 Claude Code session；一次只合并一个。

</details>

### 4.1 分工：前端、后端和 Codex

<details><summary>分工：前端、后端和 Codex</summary>

| 标记 | 含义 | 谁来做 |
|---|---|---|
| 后端 | `crates/folio-core` 和 `crates/folio-app`（Rust） | 标了 Codex 的交给 Codex，其余 Claude Code |
| 前端 | `apps/desktop`（React / TypeScript） | Claude Code（`frontend-design` 和设计评审技能） |
| 设计 | 设计画布和 handoff | Cowork |
| 构建 / 测试 / 文档 | 前端依赖、CI 和发布、实测、说明文档 | Claude Code；后端依赖和仿真 harness 属于后端编码，可以给 Codex |
| 规格 / 合约 | spec、IPC 合约、ADR | 建议 Claude Code（`engineering:system-design`、`engineering:architecture`） |

- Codex 只做后端编码（你 2026-09-28 的决定，写在上级目录的 `AGENTS.md`），规则以 `CLAUDE.md` 为准：lane 文件在 `.agents/lanes/`，spec 和 ADR 写进 `docs/`，草稿在 `folio-agent-work/tasks/<lane>/`。
- Codex 在 `Documents Manage` 目录启动；§2 里给 Codex 的提示词开头已经带上它需要的那段说明。
- Codex 做完停在 review，把评审范围写进 `claude-review-handoff.md`；合并前由 Claude Code 做 `/code-review`、`/security-review`、`/simplify`。
- Codex 发现要改界面时写前端交接，不改 `apps/desktop`。
- 关键路径（`feat/core-object-store`、`feat/core-sync-round`）交给 Codex 时要及时看进度。

</details>

## 5. 路线图

| 里程碑 | 状态 | 版本 | 完成后能做什么 |
|---|---|---|---|
| 阶段 0：清空合并队列 | ✅ 2026-09-28 | — | Tauri 2.12、合并积压的 23 个提交 |
| M1 本地资料库 | 🔄 第 3 波 | v0.1，你自己用（先在资料库的副本上用） | 日常替代资源管理器：浏览、标签、搜索、预览、导入 |
| M2 版本记录 | 🔒 等 M1 | v0.2，你自己用 | 提交、历史、文本和 Word 的差异与恢复、正文搜索 |
| M3 云端同步 | 🔒 等 M2（前置验证在 M2 期间开始） | v0.3，开始「连续用一整个学期」的实测（brief §10） | iCloud 云端仓库、同步、冲突处理 |
| M4 打磨与分发 | 🔒 等 M3（Office 预览在 M3 期间开始） | **v1.0 上线**，发给同学朋友 | Office 预览、安装包、自动更新、首次使用引导 |

「上线」按 brief §11 定为 v1.0 = M4 完成、发给同学朋友。这个定义和 M1→M4 的顺序你没有单独确认过，本文按它执行，有异议随时改。

<details><summary>四条轨道怎么并行</summary>

```text
             阶段0  M1 本地资料库              M2 版本记录              M3 云端同步              M4 打磨与分发
核心/shell   合并 ─ 状态 → 浏览/操作/文件协议 → 导入 ─ 对象库 → 工作区 → 提交/历史 → 差异/恢复 ─ 云端存储 → 镜像 → 同步 → 冲突 ─ 系统集成、发布流水线
界面         ───── 架构 ADR → 外壳 → 资料库/搜索/预览 → 导入/设置/首次使用 ─ 工作区/历史/差异 ─ 同步状态/冲突/加入仓库 ─ Office 预览、引导
设计 Cowork  ───── M1 流程补图 ──────────────── M2 细节 ─────────────── 同步与冲突 ─────────────── 引导和发布前打磨
验证         ───── Office 预览 spike ─────────── 云端格式 spec + golden ── iCloud 实测 + 同步仿真 ──── 发布候选测试、小范围试用
```

规模：S = 一个模块或一个界面局部；M = 一个完整功能，含合约测试和 e2e；L = 多个模块或一个完整视图。

</details>

M1 的明细见 §2（还没做完的）和 §3（做完的）。后面三个里程碑都还没解锁：

<details><summary>🔒 M2 版本记录 → v0.2（约 14 个 lane，等 M1）</summary>

| 状态 | 波次 | Lane | 分工 | 做什么 | 规模 |
|---|---|---|---|---|---|
| 🔒 | 规格 | `docs/specs-history-format` | 后端（规格） | `remote-format.md`（与编程语言无关的格式说明和 golden vectors，ADR-0003 行动项 2）和 `versioning.md`（本机对象库、工作区、提交日志、差异、恢复） | M |
| 🔒 | 规格 | `feat/ipc-m2-contract` | 后端（合约） | `workspace.*`、`history.*`、`ai.*` 和 AI 设置的合约 | M |
| 🔒 | 设计 | `design/design-m2-details` | 设计 · Cowork | 窄窗口下的工作区和历史、差异视图的各种状态、恢复确认 | S |
| 🔒 | 依赖 | `chore/build-deps-m2` | 后端依赖 · Codex | 差异算法、docx 解析、HTTP 客户端等 crate | S |
| 🔒 | 核心 | `feat/core-object-store` | 后端 · Codex | BLAKE3 对象、pack 编解码、本机存储，golden 测试 | L |
| 🔒 | 核心 | `feat/core-workspace` | 后端 · Codex | 工作区 = 磁盘现状对比上次提交；`WorkspaceChanged` | M |
| 🔒 | 核心 | `feat/core-commit-history` | 后端 · Codex | 提交（有日志，崩溃安全）、模板说明、修改说明、撤销提交、历史和单文件历史 | L |
| 🔒 | 核心 | `feat/core-text-extract` | 后端 · Codex | 从 md、代码、txt、docx 抽取文字进全文索引（正文搜索） | M |
| 🔒 | 核心 | `feat/core-diff-restore` | 后端 · Codex | 文本和 Word 文字的差异；恢复旧版本 = 产生一条新改动 | M |
| 🔒 | 核心 | `feat/core-ai-message` | 后端 · Codex | DeepSeek（兼容 OpenAI）只从特权层请求；Key 存在 Windows 凭据管理器；失败退回模板；要 `/security-review` | M |
| 🔒 | 界面 | `feat/ui-diff-viewer` | 前端 | 工作区和历史共用的差异组件 | M |
| 🔒 | 界面 | `feat/ui-changes-view` | 前端 | 工作区：改动列表、勾选、提交框、`Ctrl+Enter`、待同步列表 | L |
| 🔒 | 界面 | `feat/ui-history-view` | 前端 | 历史时间线、文件卡片、单文件历史、恢复 | L |
| 🔒 | 界面 | `feat/ui-settings-ai` | 前端 | AI 设置页 | S |

**M2 验收**：提交和恢复在崩溃注入下不丢数据；你自己用 v0.2 至少一两周。

</details>

<details><summary>🔒 M3 云端同步 → v0.3（约 15 个 lane，等 M2；前置验证在 M2 期间开始）</summary>

| 状态 | Lane | 分工 | 做什么 | 规模 |
|---|---|---|---|---|
| 🔒 | `test/core-icloud-field-test` | 测试 | 真实 iCloud 实测（ADR-0003 行动项 4）：冲突副本命名、NFD 文件名、大小写重命名、删除去向、固定文件夹、pack 和 head 记录先后；需要你在 iPad 上配合 | M |
| 🔒 | `test/core-sync-simulation` | 测试 · Codex | 同步仿真 harness（行动项 3）：最终一致的假云端、两台设备加「iPad」、每个日志步骤注入崩溃；长跑放夜间 CI | L |
| 🔒 | `docs/specs-sync` | 后端（规格） | 同步的 spec | M |
| 🔒 | `feat/ipc-m3-contract` | 后端（合约） | 同步的合约 | M |
| 🔒 | `design/design-sync` | 设计 · Cowork | 工具栏同步状态、进度和结果、冲突处理、创建 / 加入云端仓库、释放空间 | M |
| 🔒 | `feat/core-remote-store` | 后端 · Codex | 云端布局；推送 pack 和 head 记录；拉取并校验；选出规范 head | L |
| 🔒 | `feat/core-mirror` | 后端 · Codex | 普通文件夹镜像；覆盖前先导入；识别 iPad / Mac 上的直接修改；不合法的文件名；冲突副本 | L |
| 🔒 | `feat/core-sync-round` | 后端 · Codex | 一轮同步：拉取 → 导入直接修改 → rebase → 落地文件（删除进回收站）→ 推送；同步前快照；中断后恢复 | L |
| 🔒 | `feat/core-merge-conflicts` | 后端 · Codex | 文本三方合并；Word 由你选；其他文件两份都留 | M |
| 🔒 | `feat/core-placeholders` | 后端 · Codex | 等待占位文件下载；推送后设为「仅在云端」释放空间 | M |
| 🔒 | `feat/core-remote-watch` | 后端 · Codex | 发现云端新记录 → 工具栏显示 `↓N` | S |
| 🔒 | `feat/core-remote-setup` | 后端 · Codex | 创建云端仓库；换电脑后加入 | M |
| 🔒 | `feat/ui-sync-toolbar` | 前端 | 云端状态、`↑N` `↓N`、Sync 按钮、进度和结果 | M |
| 🔒 | `feat/ui-conflicts` | 前端 | 逐个处理冲突 | M |
| 🔒 | `feat/ui-remote-setup` | 前端 | 创建 / 加入云端仓库的流程 | M |

**M3 验收**：长时间仿真全绿；iCloud 实测通过；两台 Windows 设备加 iPad 的实机测试。之后开始「连续用一整个学期」的实测。

</details>

<details><summary>🔒 M4 打磨与分发 → v1.0（约 6 个 lane，等 M3；Office 预览在 M3 期间开始）</summary>

| 状态 | Lane | 分工 | 做什么 | 规模 |
|---|---|---|---|---|
| 🔒 | `feat/ui-office-preview` | 前端 | 按 spike 的结论接入 Word / Excel / PPT 预览 | L |
| 🔒 | `feat/ui-onboarding` | 前端 | 首次使用引导 | M |
| 🔒 | `feat/core-app-integration` | 后端 · Codex | 开机启动、快捷键、检查更新的设置 | M |
| 🔒 | `chore/build-release-pipeline` | 构建 | Tauri updater、公开的更新源、打 tag 自动构建 NSIS 并发布 | M |
| 🔒 | `docs/docs-install-guide` | 文档 | 给同学朋友的安装说明，包括 SmartScreen 怎么放行 | S |
| 🔒 | `test/build-release-candidate` | 测试 | Windows 10 和多显示器缩放；全量无障碍审查；5 万文件 / 100 GB 性能复核；整个 IPC 面的 `/security-review`；`engineering:deploy-checklist` | M |
| 🔒 | 试用 | — | 2～3 位同学试用 → 修问题 → v1.0 | — |

</details>

## 6. 需要你做的事和决定

| 时间 | 事项 | 类型 | 状态 |
|---|---|---|---|
| 每个 lane 汇报后 | 批准合并（提示词里已写好「评审通过才合并」） | 批准 | 每次 |
| 越早越好 | 把 iCloud for Windows 从 13.4 升到 Microsoft Store 的当前版本（ADR-0003 行动项 5） | 手动 | 待做 |
| 有空时 | §5 的版本定义和 M1→M4 顺序（brief §11 仍写「待确认」） | 决定 | 没单独确认，按本文执行 |
| M2 之前 | 批准 `remote-format.md`：云端格式一旦有了真实数据就很难再改 | 批准 | 🔒 |
| M3 之前 | 准备第二台 Windows 设备（或虚拟机）做双设备测试 | 手动 | 🔒 |
| M4 之前 | 更新源放在哪；要不要代码签名（智能应用控制会拦截未签名的程序，三个方案见 ADR-0001 行动项 6） | 决定 | 🔒 |

<details><summary>✅ 已经做完的决定</summary>

| 时间 | 事项 | 结果 |
|---|---|---|
| 阶段 0 | ADR-0004、合并顺序、Tauri 2.12 和窗口手动检查 | 已批准、已检查 |
| 阶段 0 | Codex 只做后端编码 | 写在 `AGENTS.md` |
| 同步点 1 | ADR-0005 界面架构 | 笔记旁边的图片 M1 就做；预览里的链接只显示地址；v0.1 的方块栏只有 Library；新开数据层 lane |
| 同步点 1 | 首次使用和资料库操作的设计；Office spike 的课程文件 | 已审阅；用了 一门课的英文课件和一份中文 PPT |
| 同步点 1 | PPT 预览程度 | 选 A：正常渲染，提示可能与 PowerPoint 略有不同（ADR-0001 行动项 4c） |
| 第 2 波 | 课程编号等对 ADR-0002 的修订（9-29）；移动的崩溃恢复扩展（9-30）；放弃未完成移动的入口（9-30） | 已批准 |
| 同步点 1、2 | 各 lane 的合并 | 已批准、已合并 |

</details>

## 7. 风险

<details><summary>8 条风险和对策</summary>

| 风险 | 影响 | 对策 |
|---|---|---|
| 合并积压、并行 lane 改同一段文件 | 分支互相卡住，合并时冲突 | §4 的规则；命令和文案已按功能组和视图拆开 |
| PPT 渲染器还不成熟 | Office 预览达不到 brief 的描述 | spike 已选方案 A，留了「用默认程序打开」 |
| iCloud for Windows 的实际行为和文档不一致 | 同步丢改动或出现冲突副本 | M3 实现前先实测和仿真；覆盖前先导入；删除只进回收站 |
| 只有一台 Windows 电脑 | 测不到双设备同步 | 虚拟机，或借一台电脑 |
| 未签名分发 | 朋友的电脑拦截安装 | M4 之前定签名方案 |
| tauri-specta 仍是 rc，版本固定 | 升级 Tauri 时绑定生成可能出问题 | 每次升级走单独的依赖 lane，由 `export_bindings` 测试把关 |
| 共用 `target/` 和 dev server | 并行 session 互相拖慢 | 最多 3 个 Rust session；e2e 用 app lock；基准测试找安静的时候跑 |
| Codex 和 Claude 的规则再次分叉 | 互相看不到占用 | `AGENTS.md` 只指向 `CLAUDE.md`；改协作规则的 lane 顺带检查 `AGENTS.md` |

</details>

## 附录 A：通用提示词

每个 lane 的启动提示词直接放在 §2 的看板里（点开「提示词」复制）；Codex lane 到 review 时用 §2 表下面的通用评审提示词。下面这段是给 Codex 的开头说明，§2 里给 Codex 的提示词已经带上了，自己写新的 Codex 提示词时加在最前面。

<details><summary>A.0 交给 Codex 时加在提示词开头</summary>

```text
Codex: follow Documents Manage/AGENTS.md and Folio/CLAUDE.md. Backend coding only: lane file in Folio/.agents/lanes/, specs and ADRs in Folio/docs/, scratch in folio-agent-work/tasks/<lane>/. Map the Claude skill names below to your skills in AGENTS.md §5. Stop at review and write the review scope into folio-agent-work/tasks/<lane>/claude-review-handoff.md; a Claude Code session runs /code-review, /security-review and /simplify before I approve the land.
```

</details>
