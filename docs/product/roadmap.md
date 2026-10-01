# Folio 上线路线图（到 v1.0）

> **状态**：v0.4，M1 第 2 波实现完成，同步点 2（评审和合并）待做 · **更新**：2026-09-30 · **决策人**：Sirui · **整理**：Claude Code
>
> 依据：产品简介 [`brief.md`](brief.md) §10–§11，四份 ADR 的行动项，各 spec 的 "Next lanes" 一节，`.agents/lanes/` 里的 lane 文件和 `but status`（2026-09-28）。每一波开始前更新本文：勾掉完成的 lane，补上下一波的启动提示。

## 1. 结论

- **现在在哪**：**M1 还没有结束**，第 2 波的实现全部完成（2026-09-30），但只合并了一半。
  - 已合并：同步点 1，以及第 2 波的合约修正、文件协议、窗口骨架和数据层。界面能在浏览器面板里用假 shell 跑起来，但资料库、搜索、预览这些视图还没有。
  - 做完、待合并：Codex 做的 library-ops（18 个命令）、browse（5 个命令）和日志 lane 都停在 review，等 Claude Code 的原生评审；修 CI 崩溃的 lane 也在等你批准。
  - **main 上的 CI 从 9-29 起一直是红的**（`folio-app` 测试在 Windows Server 2022 上 `STATUS_ACCESS_VIOLATION`），修复就在那个待合并的 lane 里。
- **下一步**：同步点 2（附录 A.11～A.15）：先合并 CI 修复让 main 变绿，再并行评审、依次合并三个 Codex lane；同时开一个前端小 lane，把剩下的数据层 hook 补齐。之后进第 3 波：4 个前端 lane 并行，Rust 名额空出来后再开 5 个后端 lane（§5、附录 A.16～A.24）。
- **还剩多少**：到 v1.0 大约 60 个 lane：M1 约 25 个（第 3 波加了数据层 hook、WebView 快捷键、STA 辅助函数合并和放弃未完成移动四个小 lane），M2 约 14 个，M3 约 15 个，M4 约 6 个。M1 合约里合并完同步点 2 就只剩导入的 3 个命令没实现。
- **分工**（每个 lane 在表里标了「分工」，说明见 §4.1）：Codex 只做后端编码（你 2026-09-28 的决定，写在上级目录的 `AGENTS.md`），约 24 个后端 lane 可以交给 **Codex**；21 个前端 lane，以及 11 个规格、合约、前端依赖、发布、实测和说明文档 lane 由 Claude Code 做；3 个设计 lane 由 Cowork 做。
- **需要你现在决定**：批准同步点 2 的合并（CI 修复、日志、library-ops、browse）。§2 的版本定义和 M1→M4 的顺序没有单独确认过，本文按它执行，有异议随时改。完整清单见 §6。

## 2. 「上线」指什么（建议）

brief §11 把 M4 定为「可以发给同学朋友用」，所以本文把 **v1.0 = M4 完成、发给同学朋友** 当作上线。每个里程碑之后先出一个只给你自己用的版本，尽早真正用起来：

| 版本 | 完成的里程碑 | 谁用 | 能做什么 |
|---|---|---|---|
| v0.1 | M1 本地资料库 | 你自己（先在资料库的副本上用） | 日常替代资源管理器：浏览、标签、搜索、预览、导入 |
| v0.2 | M2 版本记录 | 你自己 | 提交、历史、文本和 Word 的差异与恢复、正文搜索 |
| v0.3 | M3 云端同步 | 你自己，从这里开始「连续用一整个学期」的实测（brief §10） | iCloud 云端仓库、同步、冲突处理 |
| v1.0 | M4 打磨与分发 | 同学朋友 | Office 预览、安装包、自动更新、首次使用引导 |

## 3. 当前进度（2026-09-30，M1 第 2 波之后）

### 3.1 已在 main 上（120 个提交；CI 从 9-29 起失败，见 §3.2）

| 方面 | 内容 |
|---|---|
| 产品与决策 | brief v0.3（英文界面、课程编号、新布局）；ADR-0001 技术栈、ADR-0002 数据存储、ADR-0003 版本与同步格式、ADR-0004 M1 IPC 合约、ADR-0005 界面架构均已接受；system overview、testing strategy、ui-architecture；本路线图 |
| 工程底座 | Tauri 2.12 + React + Rust 工作区；类型化 IPC（tauri-specta）；Playwright 通过 WebView2 CDP 跑 e2e；GitHub Actions CI（windows-2022）；app lock 在 `.agents/locks/` |
| 英文界面 | `en` 为默认语言，每个视图一个 namespace，`tsc` 检查每个 `t()` 的 key |
| 技术验证 | 自绘标题栏 + Windows 11 贴靠布局（ADR-0001 4b，含顶部缩放边和读屏修复）；预览沙箱 iframe（安全基线）；中文分词器 `folio_cjk`（5 万条目上一页结果 1～81 ms）；tauri-specta 端到端（4d）；CI 上的 e2e（4a） |
| 核心库 `folio-core` | 库内路径和 Windows 命名规则；`.folio/` 元数据读写；SQLite catalog（迁移、恢复）；排序搜索和高亮；扫描与对账（标签跟着文件移动、忽略规则、哈希）；5 万文件的扫描基准 |
| Windows 适配 | NTFS 文件 ID 和 iCloud 占位文件识别；只进回收站、绝不永久删除；文件监视和防抖的局部重扫 |
| IPC 合约 | M1 的命令、事件和错误的类型（含合约修正加的 `resolve_paths` 和 `log_ui_error`）；生成的 bindings 和界面侧封装；planned 命令只声明、不注册；命令注册按功能组拆开（每组自己的清单和 capability 文件） |
| 资料库状态 | 设置文件、`LibraryState`、任务注册表；新建、接管、打开资料库（含建到一半的资料库）；启动扫描和哈希；文件监视 → `CatalogChanged`；安全关窗。8 个命令 |
| 文件协议 | 只读的 `folio-file` 协议（失败时说明原因）、按 catalog 哈希缓存缩略图、用默认程序打开（媒体、笔记、Office；不运行程序，拦截加载项）、在资源管理器中显示 |
| 设计 | 设计 token（浅色和深色）；app-shell、首次使用、资料库操作三份 handoff；从 token 生成的 CSS 和尺寸常量 |
| 界面 | 依赖已装（ADR-0005）；窗口骨架：标题栏、工具栏、方块栏（只有 Library，先是占位）、对话框、提示、任务活动按钮、窗口命令失败；共用组件（React Aria）；ESLint 目录和安全规则；数据层（TanStack Query、按 revision 失效）；假 shell（含 5 万条的数据），浏览器面板和组件测试都用它 |
| 研究 | Office 预览 spike，PPT 选方案 A（正常渲染，提示可能与 PowerPoint 略有不同） |

### 3.2 等合并（同步点 2）

| 分支 | 提交 | 内容 | 还差什么 |
|---|---|---|---|
| `fix/build-ci-access-violation`（Claude Code） | 1 | 修 CI 崩溃：WinRT 工厂缓存在 COM 卸载后失效；进程内一直保持 MTA。CI 上验证过通过；三项评审都做了 | 你批准合并 |
| `chore/core-logging`（Codex） | 1 | 日志按天轮转、保留 7 天；`log_ui_error` 命令（长度上限、限流）。约 530 行 | Claude Code 的三项原生评审；你批准合并 |
| `feat/core-library-ops`（Codex） | 3 | 学期、课程、标签和条目的 18 个命令（删除只进回收站）；元数据格式 2 和 catalog 迁移 2（你 9-29 批准）；移动的崩溃恢复（你 9-30 批准）；`library_status` 重试。约 8,100 行 | 同上 |
| `feat/data-browse-queries`（Codex） | 1 | 树、列表、网格、搜索和 `resolve_paths` 的 5 个命令；5 万条目上 200 行一页最慢 43 ms、50 条搜索最慢 64 ms。约 4,500 行 | 同上 |

三个 Codex lane 各自的 `pnpm check` 和 e2e 都通过了（在合在一起的工作区上），评审范围写在 `../folio-agent-work/tasks/<lane>/` 的 `claude-review-handoff.md`（日志 lane 是 `verification-and-handoff.md`）。

### 3.3 还没开始的

- **M1 功能层**：导入的 3 个命令（`pick_import_files`、`check_import`、`import_files`）和本机设置还没实现；资料库、搜索、预览、导入、设置、首次使用这些视图都还没有。
- **M2 和 M3 的前置工作**：`remote-format.md` 和 golden vectors（ADR-0003 行动项 2，「M2 之前」）；同步仿真 harness（行动项 3，「M3 之前」）；真实 iCloud 实测（行动项 4）和它的前提——把开发机上的 iCloud for Windows 从 13.4 升级（行动项 5，要你来做）。
- **分发**：更新源、签名方案、安装说明（ADR-0001 行动项 6）。

### 3.4 零散待办（都已归入下面的 lane）

| 来源 | 待办 | 归入 |
|---|---|---|
| WP-04 | Tauri 2.11 → 2.12 | 阶段 0 `chore/build-deps-tauri-2-12`（已合并） |
| first-run §12、library-actions §16 | 合约缺口：导入列表分不出文件夹；回收站不可用没有自己的错误码；预览失败一律 404，分不出「被占用」和「不在本机」；启动时打不开资料库后没法重试；界面错误写不进日志 | M1 第 2 波 `feat/ipc-m1-contract-fixes`（和 `resolve_paths` 一起） |
| library-actions §16 | 学期和资料库根目录下不属于任何课程的零散文件在树里放在哪 | M1 `feat/data-browse-queries`、`feat/ui-library-view` |
| library-state 交接 | 原生选文件夹对话框只用测试替身跑过，没有手动点过 | M1 `feat/ui-first-run` 手动检查 |
| coordinator notes | 用正式日志模块替换 `diagnostics.rs`（按天轮转，保留 7 天） | M1 `chore/core-logging` |
| coordinator notes | 窗口命令失败只写到控制台，需要界面上的错误状态 | M1 `feat/ui-app-shell` |
| coordinator notes | 搜索高亮只能当文本渲染，不能走 `innerHTML` | M1 `feat/ui-search-palette` |
| coordinator notes | 关窗由 shell 负责，页面拦不住；有了后台任务（以后还有未保存的内容），要重新设计退出流程 | M1 `feat/core-library-state` |
| coordinator notes | 窗口对所有事件都有 `core:event:allow-listen`；要收窄，得先有按事件划分的通道 | M4 `test/build-release-candidate` |
| `feat/ui-token-css` | 还没有代码设置 `data-theme` 和 `data-reduce-motion`；深色模式下首帧可能闪白 | M1 `feat/ui-app-shell`、`feat/ui-settings` |
| handoff §12 | 首次使用、拖放目标、右键菜单、错误状态等还没画 | M1 Cowork `design/design-m1-flows` |
| ipc-m1 §20 | 课程编号等元数据改动要同时修订 ADR-0002 和 library-core | M1 `feat/core-library-ops` |
| ADR-0001 4b | Windows 10、缩放比例不同的多显示器还没测 | M4 `test/build-release-candidate` |
| ADR-0002 行动项 5 | 第一个发布的 schema 需要 fixture | M1 验收 |
| library-scan §12.4 | 哈希时每个文件打开三次等性能改进 | M4 性能复核时按需处理 |
| CI（9-29 起） | main 上 `folio-app` 测试在 Windows Server 2022 崩溃 | 同步点 2 合并 `fix/build-ci-access-violation` |
| CI 修复 lane | 两个几乎一样的 STA 辅助函数：`folio-app` 的 `dialogs::in_sta` 和 `folio-core` 的 `win::recycle::in_apartment` | M1 第 3 波 `refactor/core-sta-helper` |
| ui-architecture §17 第 4 项 | Tauri 没有开放 WebView2 的浏览器快捷键开关；正式版里 F5、Ctrl+F、Ctrl+P 等浏览器快捷键还在 | M1 第 3 波 `chore/core-webview-accelerator-keys` |
| 第 2 波 | 只有资料库状态、任务和问题有数据层 hook；学期课程、标签、条目改动、搜索、文件、导入的 hook 还没有，几个视图 lane 都要用 | 同步点 2 `feat/ui-data-m1-hooks` |
| A.13 评审 | 应用内移动做到一半崩溃后，如果文件、元数据或目录数据库又变了，恢复会一直失败，资料库打不开，重建也没用，只能手动删 `.folio/local/journal/scan.json`；你 2026-09-30 批准加「放弃这次未完成的移动」入口 | M1 第 3 波 `feat/core-discard-move`（合约和后端）、`feat/ui-first-run`（打不开界面上的按钮） |

## 4. 用 GitButler 排任务的规则

来自 CLAUDE.md §7 和这几天的实际情况：23 个提交积压；一个三层 stack 被另一个分支卡住；`feat/ui-i18n-english` 要等两个分支合并才能开始。

1. **先合并，再开新 lane。** review 完的 lane 尽快 land。工作区里同时应用的分支越多，GitButler 的 hunk 依赖和冲突越多。每一波开始前，上一波应基本合并完。
2. **合约先行。** 每个里程碑先有一个 `feat/ipc-mN-contract` lane 定下命令和类型并 land；之后核心 lane 和界面 lane 在 main 上并行，界面用 mock 的 `ipc` 模块开发，不等核心。实现 lane 不改合约；确实要改，就开一个小的合约修正 lane 先合并。合约 lane 重新生成 bindings 时，在同一个 lane 里更新界面的假 shell（`apps/desktop/src/ipc/mock/`）和它的指纹，否则 `pnpm check` 不通过（2026-09-30 定）。
3. **stack 只给真实依赖，最多两层。** 能等上游 land 再开的，就不要 stack。只改文档、一起合并的 stack 例外。
4. **按目录分所有权。** 核心 lane 拥有 `crates/folio-core/src/<模块>/**`，shell lane 拥有 `crates/folio-app/src/<功能>`，界面 lane 拥有 `apps/desktop/src/<视图>/**`。不再让一个 lane 拥有整个 `crates/folio-core/**`。
5. **拆开热点文件。** 并行 lane 最容易在同一段列表上撞车：
   - IPC 注册（`ipc.rs` 里的命令列表、`build.rs`、`capabilities/`）：由 `feat/core-library-state` 先改成每个功能组各自注册、各自一个 capability 文件；
   - 界面文案：由 `feat/ui-i18n-english` 把语言文件按视图拆成 namespace；
   - lockfile：每个里程碑一个 `chore/build-deps-*` lane 集中装依赖（独占操作）。
6. **并行上限：最多 3 个写 Rust 的 session（Claude Code 和 Codex 合计），界面 session 按目录分开可以开到 4 个，另加 Cowork。** 所有 session 共用一个 `target/` 目录和一个 dev server，`pnpm e2e` 用 app lock 排队；跑基准测试要找没有别的构建在跑的时候。
7. **独占操作放在波次之间的「同步点」。** `but land`、`but pull`、装依赖、Tauri 升级都在同步点做；做之前确认其他 lane 都是 `checkpoint`、`review` 或 `done`。
8. **每个 lane 同样收尾。** `pnpm check` + `pnpm e2e` → `/code-review`（改到特权层或 IPC 再加 `/security-review`）→ `/simplify` → 用中文向你汇报 → 你批准 → `but land` → `but status` 确认 → 删 lane 文件。
9. **CI 红了先修。** main 的 CI 失败时，先合并修复，再合并别的 lane。9-29 到 9-30 CI 一直是红的，这期间合并的 6 个 lane 都没有 CI 把关。
10. **Codex lane 一到 review 就安排评审。** 第 2 波有三个 Codex lane（约 1.3 万行）同时停在 review 等 Claude 评审，成了合并的瓶颈。每个 Codex lane 进入 review 时，就开一个 Claude Code 评审 session（附录 A.12～A.14 的提示可以照抄）。一次只合并一个，合并前确认其他 lane 是 `checkpoint` 或 `review`。

### 4.1 分工：前端、后端和 Codex

| 标记 | 含义 | 谁来做 |
|---|---|---|
| 后端 | `crates/folio-core` 和 `crates/folio-app`（Rust：核心逻辑、shell、IPC 命令） | 标了 Codex 的交给 Codex，其余 Claude Code |
| 前端 | `apps/desktop`（React / TypeScript 界面） | Claude Code：要按设计规格做视觉和交互，用 `frontend-design` 和设计评审技能 |
| 设计 | 设计画布和 handoff 规格 | Cowork |
| 构建 / 测试 / 文档 | 前端依赖、CI 和发布；实测；说明文档 | Claude Code；后端的 Rust 依赖和仿真 harness 属于后端编码，标了 Codex |
| **· Codex** | 可以交给 Codex：后端编码，有写好的规格和合约，产出是 Rust 代码和测试 | Codex |
| 规格 / 合约 | spec、IPC 合约、ADR：决定别的 lane 怎么写，项目规定用 `engineering:system-design` 和 `engineering:architecture` | 建议 Claude Code |

交给 Codex 时要注意：

1. **Codex 只做后端编码（你 2026-09-28 的决定）。** 上级目录的 `AGENTS.md` 写明：Codex 只做 `folio-core` 和 `folio-app` 的后端编码，不做前端、视觉设计、一般产品文档、前端依赖和发布 lane；其余规则以 `CLAUDE.md` 为准：lane 文件写在 `.agents/lanes/`，后端需要的 spec 和 ADR 写进仓库的 `docs/`，草稿放 `folio-agent-work/tasks/<lane>/`。本文的 Codex 标记已按这个范围调整。标记只说明「可以给」，lane 仍由你来开。
2. **评审由 Claude Code 补。** Codex 用自己的技能先做代码评审和安全评审，但 `CLAUDE.md` 要求的 `/code-review`、`/security-review`、`/simplify` 仍由一个 Claude Code session 在合并前做（§4 第 10 条）。Codex 会把评审范围写进 `folio-agent-work/tasks/<lane>/claude-review-handoff.md`，评审 session 从那里开始。
3. **跨层问题交给前端 lane。** Codex 发现要改界面时，写一份具体的前端交接（命令、类型、预期行为、错误情况），不自己改 `apps/desktop`。
4. **关键路径要盯。** `feat/core-library-state`、`feat/core-object-store`、`feat/core-sync-round` 卡住会挡住后面整波 lane。WP-03 曾经卡在半路（2026-09-27），这几个交给 Codex 时要及时看进度。
5. **启动方式。** Codex 在 `Documents Manage` 目录启动（这样才会读到 `AGENTS.md`），提示和给 Claude 的一样，开头加附录 A.0 的一句。

## 5. 路线图

四条轨道并行，里程碑之间有重叠：M3 的前置验证在 M2 期间开始；M4 的 Office 预览在 M3 期间由界面轨道先做。

```text
             阶段0  M1 本地资料库              M2 版本记录              M3 云端同步              M4 打磨与分发
核心/shell   合并 ─ 状态 → 浏览/操作/文件协议 → 导入 ─ 对象库 → 工作区 → 提交/历史 → 差异/恢复 ─ 云端存储 → 镜像 → 同步 → 冲突 ─ 系统集成、发布流水线
界面         ───── 架构 ADR → 外壳 → 资料库/搜索/预览 → 导入/设置/首次使用 ─ 工作区/历史/差异 ─ 同步状态/冲突/加入仓库 ─ Office 预览、引导
设计 Cowork  ───── M1 流程补图 ──────────────── M2 细节 ─────────────── 同步与冲突 ─────────────── 引导和发布前打磨
验证         ───── Office 预览 spike ─────────── 云端格式 spec + golden ── iCloud 实测 + 同步仿真 ──── 发布候选测试、小范围试用
```

规模：**S** = 一个模块或一个界面局部；**M** = 一个完整功能，含合约测试和 e2e；**L** = 多个模块或一个完整视图。

分工：**后端** / **前端** / **设计** / **构建** / **测试** / **文档**，标了 **· Codex** 的可以交给 Codex（§4.1）。

### 阶段 0：清空合并队列（已完成，2026-09-28）

| 步骤 | 分工 | 做什么 | 状态 |
|---|---|---|---|
| 0.1 | 文档 | 批准 ADR-0004，状态改为 Accepted | 已完成 |
| 0.2 | 版本管理 | 按顺序 land：① `fix/core-snap-overlay-edges` ② `feat/core-windows-watcher --whole-stack` ③ `feat/ipc-m1-contract` ④ `feat/ui-token-css --whole-stack` | 已完成，main 上的 CI 通过 |
| 0.3 | 构建 · Codex | `chore/build-deps-tauri-2-12`：Tauri 升到 2.12 | 已合并（Claude 评审后补了 `windows` 依赖的版本固定和 ADR-0001 的记录） |
| 0.4 | 版本管理 | 整理：`.agents/work/` 只作只读存档（CLAUDE.md §7.7）；app lock 移到 `.agents/locks/app`（§7.5） | 已合并 |
| 0.5 | 版本管理 | 收尾：评审并合并 Tauri 升级，合并三个文档分支 | 已完成 |

### M1 本地资料库 → v0.1（约 24 个 lane）

**第 1 波**（已全部合并，2026-09-29）

| Lane | 分工 | 做什么 | 依赖 | 拥有路径 | 规模 |
|---|---|---|---|---|---|
| `feat/core-library-state` | 后端 · Codex | 先拆 IPC 注册（§4 第 5 条）；设置文件、`LibraryState`、任务注册表和 `JobChanged`；新建、接管、打开资料库；启动扫描和哈希任务；文件监视 → `CatalogChanged`；任务、问题、重建索引的命令（ipc-m1 §21 第 1、6 项） | 步骤 0.5 已合并 | `crates/folio-app/src/` 的状态、任务、命令注册，`build.rs`，`capabilities/`；`folio-core` 里需要的 library 部分 | L |
| `docs/adr-0005-ui-architecture` | 前端（架构） | 界面架构 ADR：数据缓存（按 `CatalogChanged` 的 revision 失效）、视图切换、无障碍组件库、长列表虚拟化、浏览器里用的 mock IPC、目录结构、M1 预览库选型；列出要装的 npm 包 | — | `docs/adr/ADR-0005-*`、`docs/specs/ui-architecture.md` | M |
| `feat/ui-i18n-english` | 前端 | 加 `en` 并设为默认，全部翻译；语言文件按视图拆 namespace；`t()` 的 key 按 `en` 做类型检查；改掉按中文名找按钮的 e2e | —（①③ 已合并） | `apps/desktop/src/i18n/**` | S |
| `spike/ui-office-preview` | 前端（验证） | ADR-0001 4c：用你的真实课程文件（含中文 PPT）比较 docx-preview、SheetJS 和两个 PPT 渲染器，在预览沙箱的 CSP 下测保真度、速度、体积；试验代码放在仓库外，不动 lockfile | — | ADR-0001 的 4c 一项、`docs/research/office-preview-spike.md` | M |
| `design/design-m1-flows` | 设计 · Cowork | 补画 handoff §12 缺的：首次使用（欢迎、新建、接管、建第一个学期和课程）、拖放目标和导入对话框（同名文件：替换 / 都保留 / 跳过）、右键菜单、错误和空状态、任务进度和问题列表 | — | `docs/design/handoff/` 下的新规格、`design/tokens/**` | M |

**同步点 1**（已完成，2026-09-29）：提交并合并 Cowork 的设计和 spike；评审并合并 `feat/core-library-state`；`chore/build-deps-ui-m1` 装好 M1 界面依赖。

**第 2 波**（实现全部完成，2026-09-30。合约修正、文件协议、窗口骨架、数据层已合并；library-ops、browse、日志在同步点 2 评审和合并）。合约 lane 原名 `feat/ipc-m1-resolve-paths`，现在把设计交接列出的合约缺口一起补上，改名 `feat/ipc-m1-contract-fixes`：只重新生成一次 bindings，后端 lane 也只需要等一个合约 lane。

| Lane | 分工 | 做什么 | 依赖 | 拥有路径 | 规模 |
|---|---|---|---|---|---|
| `feat/ipc-m1-contract-fixes` | 后端（合约） | 声明 `resolve_paths`（笔记旁边的图片，ADR-0005 产品决定 1，ui-architecture §10.4）和界面错误写日志的命令（ui-architecture §13）；导入列表标出文件夹、回收站不可用的错误码、预览失败原因、启动时重试打开资料库（§3.4）；只声明、不注册，重新生成 bindings；尽早合并 | library-state 已合并 | `docs/specs/ipc-m1.md`、`folio-app` 的 IPC 类型和各功能组的 planned 声明、`bindings.ts`、`en/errors` | S |
| `feat/data-browse-queries` | 后端 · Codex | 树、列表、网格的查询（自然排序、继承的标签、多个标签取交集、「最近添加」「未打标签」、学期里的零散文件）和分页搜索，以及对应命令；实现 `resolve_paths` | library-state、合约修正 | `folio-core` 的查询模块、`folio-app` 的浏览命令组 | M |
| `feat/core-library-ops` | 后端 · Codex | 学期、课程、标签、条目的增改删和排序（删除只进回收站，回收站不可用时用新错误码）；课程编号等元数据改动，同时修订 ADR-0002 和 library-core（ipc-m1 §20，需你批准）；`library_status` 重试打开资料库 | library-state、合约修正 | `folio-core` 的操作模块、`meta/model.rs` 和 catalog 的 schema 迁移、`folio-app` 的操作命令组 | L |
| `feat/core-file-scheme` | 后端 · Codex | `folio-file` 协议（只读，限定在资料库内，失败时说明原因）、缩略图缓存、用默认程序打开（从不运行程序或脚本）、在资源管理器中显示；CSP；e2e 证明预览 frame 读不到这个协议 | library-state、合约修正 | `folio-app` 的文件协议、缩略图、打开 | M |
| `feat/ui-app-shell` | 前端 | 窗口骨架：标题栏、工具栏（同步部分先占位）、方块栏（M2 之前只有 Library）、内容区、窄窗口布局；主题和减少动态效果；WebView2 背景色（不闪白）；handoff §10 的共用组件；窗口命令失败的错误状态；ESLint 的目录和安全规则 | ADR-0005、依赖、i18n | `apps/desktop/src/` 的 `app/`、`components/`、`lib/`、`titlebar/` | L |
| `feat/ui-data-layer` | 前端 | 数据层：TanStack Query 缓存、按 `CatalogChanged` 失效、分页列表、跟随移动的引用；浏览器面板和组件测试用的假 shell（含 5 万条的数据）；测试渲染工具（ui-architecture §5、§11） | ADR-0005、依赖 | `apps/desktop/src/` 的 `data/`、`ipc/mock/`、`test/` 的渲染工具 | M |
| `chore/core-logging` | 后端 · Codex | 正式日志模块替换 `diagnostics.rs`（按天轮转，保留 7 天）；实现界面错误写日志的命令 | 合约修正 | `folio-app` 的日志 | S |

**同步点 2**（现在；附录 A.11～A.15）

| 步骤 | Lane | 分工 | 做什么 | 依赖 | 规模 |
|---|---|---|---|---|---|
| A.11 | `fix/build-ci-access-violation` | 构建 | 合并 CI 修复，确认 main 的 CI 变绿 | — | S |
| A.12 | `chore/core-logging` | 评审 | Claude Code 原生评审 Codex 的日志 lane，然后合并 | A.11 | S |
| A.13 | `feat/core-library-ops` | 评审 | 同上，library-ops（约 8,100 行，重点是崩溃恢复和操作锁） | A.11 | L |
| A.14 | `feat/data-browse-queries` | 评审 | 同上，browse（约 4,500 行，重点是新的 FTS 回调和快照读） | A.11；在 A.13 之后合并 | L |
| A.15 | `feat/ui-data-m1-hooks` | 前端 | 补齐第 3 波几个视图共用的数据层 hook：学期课程、标签、条目改动、搜索、文件、资料库的选择和新建、导入。按假 shell 写；不做视图 | — | S |

- A.12～A.15 可以同时开：三个评审 session 占满 3 个 Rust 名额，A.15 只写前端。
- 合并一次一个：A.11 → A.12 → A.13 → A.14，A.15 做完随时合并。A.13 和 A.14 都改了 `folio-app` 的 `library/mod.rs` 和 `worker.rs`（browse 只加了只读的几行），先合 A.13 更稳。

**第 3 波**（同步点 2 之后，分两组并行；附录 A.16～A.24）

前端组：A.15 合并后就开，4 个 lane 的目录互不重叠，各自注册到 `app/registry.ts`（一行）。开发用假 shell，不用等后端合并；最后跑真实 app 的 e2e 时，对应的后端要已经在 main 上。

| Lane | 分工 | 做什么 | 依赖 | 拥有路径 | 规模 |
|---|---|---|---|---|---|
| `feat/ui-library-view` | 前端 | 资料库视图（替换现在的占位）：课程树（含学期里的零散文件）、标签筛选、最近添加和未打标签、列表 / 网格、排序、多选、新建文件夹、重命名 / 移动 / 删除、批量打标签、右键菜单、空和错误状态；第三栏放预览区 | A.15（e2e 要 A.13、A.14） | `src/library/**` | L |
| `feat/ui-preview` | 前端 | 预览区：图片、PDF、Markdown（公式、代码高亮、清洗、笔记旁边的图片）、代码、音视频、其他；预览头部（标签、打开、在资源管理器中显示）；Office 文件在 M1 先显示「用默认程序打开」；每个文件一个新 frame；`preview.rs` 的 CSP 加 `worker-src blob:` 和 `'wasm-unsafe-eval'`（要 `/security-review`）；验证 pdf.js、Temml 和 HEIC | A.15（e2e 要 A.14） | `src/preview/**`、`preview.rs` | L |
| `feat/ui-search-palette` | 前端 | `Ctrl+K` 搜索：输入即出结果、分组、高亮只当文本渲染、方向键和回车（在资料库里选中并预览） | A.15（e2e 要 A.14） | `src/search/**` | M |
| `feat/ui-first-run` | 前端 | 从第 4 波提前：欢迎页 → 新建或接管资料库 → 第一个学期和课程；资料库打不开时的界面和重试；手动点一次原生选文件夹对话框 | A.15（e2e 要 A.13） | `src/first-run/**` | M |

后端组：A.12～A.14 合并、Rust 名额空出来后开，同时最多 3 个（先开 core-import、app-settings 和一个小 lane）。

| Lane | 分工 | 做什么 | 依赖 | 拥有路径 | 规模 |
|---|---|---|---|---|---|
| `feat/core-import` | 后端 · Codex | M1 最后 3 个命令：选择文件对话框、原生拖放（`dragDropEnabled` 和一次性 token）、`check_import`（标出文件夹）、带进度的导入任务、同名处理、可选把原文件移进回收站；定下 `ImportResult` 的计数口径；planned 命令清空后按 `ipc.rs` 的说明收尾 | A.13 | `folio-app` 的导入命令组、`folio-core` 的导入模块 | M |
| `feat/core-app-settings` | 后端（含合约） | M1 要用的本机设置，合约和实现一起：设备名、外观、减少动态效果、忽略规则（改了要重扫）；同一个 lane 里更新假 shell | Rust 名额 | `folio-app` 的设置命令组、`settings.rs`、假 shell 的设置文件 | S |
| `chore/core-webview-accelerator-keys` | 后端 · Codex | 正式版关掉 WebView2 的浏览器快捷键（ui-architecture §17 第 4 项）；debug 和 e2e 不变 | Rust 名额 | `folio-app` 的窗口初始化 | S |
| `refactor/core-sta-helper` | 后端 · Codex | 两个 STA 辅助函数合成一个，保留 CI 修复的 MTA 规则（§3.4） | A.11、A.13 | `folio-app` 的 `dialogs.rs`、`folio-core` 的 `win/` | S |
| `feat/core-discard-move` | 后端（含合约） | 应用内移动做到一半崩溃、之后又对不上时：`library_status` 给出单独的打不开原因，加一个要确认的「放弃这次未完成的移动」命令（不动用户文件，不覆盖已经改过的元数据，删掉 journal 后全量扫描）；同一个 lane 里更新假 shell | A.13 | `folio-core` 里放弃移动的函数、新命令和它的授权 | S |

**第 4 波**（第 3 波对应的 lane 合并后；提示到时补）

| Lane | 分工 | 做什么 | 依赖 | 规模 |
|---|---|---|---|---|
| `feat/ui-import` | 前端 | 拖放目标、「Add files」、导入对话框（标签、同名处理、删除原文件）、进度和结果 | core-import、library-view | M |
| `feat/ui-settings` | 前端 | Library settings（学期、课程、标签、忽略规则、重建索引）和 App settings（设备名、外观、减少动态效果） | core-app-settings、library-view | M |

**下一阶段可以并行的任务**（按时间顺序，同一行可以同时开）

| 时间 | 同时进行 | 谁 | 限制 |
|---|---|---|---|
| 现在 | A.11：合并 CI 修复（顺带合并本路线图的这次更新） | Claude Code ×1 | 很快；它合并前别的 lane 不合并 |
| A.11 合并后 | A.12、A.13、A.14 三个评审，加 A.15 数据层 hook | Claude Code ×4 | 三个评审占满 Rust 名额；合并一次一个 |
| A.15 合并后（不用等评审） | 第 3 波前端组：library-view、preview、search、first-run | Claude Code ×4（忙不过来就先开 library-view 和 preview，它们最大） | 共用一个 dev server；`pnpm e2e` 用 app lock 排队；preview 改 `preview.rs` 时算一个 Rust session |
| A.12～A.14 合并后 | 第 3 波后端组：core-import、core-app-settings、三个小 lane | Codex ×3 + Claude Code ×2 | 同时最多 3 个写 Rust；Codex lane 一到 review 就开评审（§4 第 10 条） |
| 第 3 波合并后 | 第 4 波：ui-import、ui-settings | Claude Code ×2 | — |
| 第 4 波合并后 | M1 验收，出 v0.1 | Claude Code ×1 | 见下 |

**M1 验收（出 v0.1 之前）**

- 每个用户流程都有 Playwright e2e；每个新界面都过了 `design:design-critique` 和 `design:accessibility-review`，并检查过减少动态效果。
- 在 5 万文件的资料库上：一页 200 行 < 50 ms，搜索一页 < 100 ms，常见文件 1 秒内出预览。
- 冻结 catalog schema v1 和 `.folio` 格式 v1 的 fixture（ADR-0002 行动项 5）：从此每次改格式都带迁移和测试。
- 过一遍 `engineering:tech-debt`；打一个未签名的 NSIS 安装包给你自己，先在资料库的**副本**上用一两周。

### M2 版本记录 → v0.2（约 14 个 lane）

| 波次 | Lane | 分工 | 做什么 | 规模 |
|---|---|---|---|---|
| 规格 | `docs/specs-history-format` | 后端（规格） | `remote-format.md`（与编程语言无关的格式说明和 golden vectors，ADR-0003 行动项 2）和 `versioning.md`（本机对象库、工作区、提交日志、差异、恢复） | M |
| 规格 | `feat/ipc-m2-contract` | 后端（合约） | `workspace.*`、`history.*`、`ai.*` 和 AI 设置的合约 | M |
| 设计 | `design/design-m2-details` | 设计 · Cowork | 窄窗口下的工作区和历史、差异视图的各种状态、恢复确认 | S |
| 依赖 | `chore/build-deps-m2` | 后端依赖 · Codex | 差异算法、docx 解析、HTTP 客户端等 crate | S |
| 核心 | `feat/core-object-store` | 后端 · Codex | BLAKE3 对象、pack 编解码、本机存储，golden 测试 | L |
| 核心 | `feat/core-workspace` | 后端 · Codex | 工作区 = 磁盘现状对比上次提交；`WorkspaceChanged`（stack 在 object-store 上） | M |
| 核心 | `feat/core-commit-history` | 后端 · Codex | 提交（有日志，崩溃安全）、模板说明、修改说明、撤销提交、历史和单文件历史 | L |
| 核心 | `feat/core-text-extract` | 后端 · Codex | 从 md、代码、txt、docx 抽取文字进全文索引（正文搜索） | M |
| 核心 | `feat/core-diff-restore` | 后端 · Codex | 文本和 Word 文字的差异；恢复旧版本 = 产生一条新改动 | M |
| 核心 | `feat/core-ai-message` | 后端 · Codex | DeepSeek（兼容 OpenAI）请求只从特权层发出；Key 存在 Windows 凭据管理器；长度上限；失败退回模板；必须过 `/security-review` | M |
| 界面 | `feat/ui-diff-viewer` | 前端 | 工作区和历史共用的差异组件 | M |
| 界面 | `feat/ui-changes-view` | 前端 | 工作区：改动列表、勾选、提交框、`Ctrl+Enter`、待同步列表 | L |
| 界面 | `feat/ui-history-view` | 前端 | 历史时间线、文件卡片、单文件历史、恢复 | L |
| 界面 | `feat/ui-settings-ai` | 前端 | AI 设置页 | S |

**M2 验收**：提交和恢复在崩溃注入下不丢数据；你自己用 v0.2 至少一两周。

### M3 云端同步 → v0.3（约 15 个 lane）

**前置（M2 期间就开始）**

- 你：把 iCloud for Windows 从 13.4 升级到 Microsoft Store 的当前版本（ADR-0003 行动项 5）。
- `test/core-icloud-field-test`（测试）：按 ADR-0003 行动项 4 在真实 iCloud 上实测：冲突副本怎么命名、NFD 文件名、只改大小写的重命名、删除去了哪里、固定文件夹里新文件是否继承、pack 和 head 记录谁先到。需要你配合在 iPad 上操作，结论写回 ADR-0003。
- `test/core-sync-simulation`（测试 · Codex）：同步仿真 harness（行动项 3）：最终一致的假云端、两台设备加一个「iPad」、每个日志步骤都注入崩溃；长时间运行放进 CI 的夜间任务。
- `docs/specs-sync`（后端（规格））和 `feat/ipc-m3-contract`（后端（合约））；`design/design-sync`（设计 · Cowork）：工具栏同步状态、同步进度和结果、冲突处理、创建 / 加入云端仓库、释放空间。

| Lane | 分工 | 做什么 | 规模 |
|---|---|---|---|
| `feat/core-remote-store` | 后端 · Codex | 云端布局；推送 pack 和 head 记录；拉取并校验；选出规范 head | L |
| `feat/core-mirror` | 后端 · Codex | 普通文件夹镜像；覆盖前先导入；识别 iPad / Mac 上的直接修改；Windows 上不合法的文件名；冲突副本 | L |
| `feat/core-sync-round` | 后端 · Codex | 一轮同步：拉取 → 导入直接修改 → rebase 本机提交 → 落地文件（删除进回收站）→ 推送；同步前快照；中断后恢复 | L |
| `feat/core-merge-conflicts` | 后端 · Codex | 文本三方合并；Word 由你选；其他文件两份都留 | M |
| `feat/core-placeholders` | 后端 · Codex | 等待占位文件下载（有进度和超时）；推送后设为「仅在云端」释放空间 | M |
| `feat/core-remote-watch` | 后端 · Codex | 发现云端新记录 → 工具栏显示 `↓N`，不改本机 | S |
| `feat/core-remote-setup` | 后端 · Codex | 创建云端仓库；换电脑后从云端仓库加入 | M |
| `feat/ui-sync-toolbar` | 前端 | 工具栏的云端状态、`↑N` `↓N`、Sync 按钮、进度和结果 | M |
| `feat/ui-conflicts` | 前端 | 逐个处理冲突 | M |
| `feat/ui-remote-setup` | 前端 | 创建 / 加入云端仓库的流程 | M |

**M3 验收**：长时间仿真全绿；iCloud 实测通过；两台 Windows 设备（另一台可以是虚拟机）加 iPad 的实机测试。之后开始「连续用一整个学期」的实测（brief §10）。

### M4 打磨与分发 → v1.0（约 6 个 lane）

| Lane | 分工 | 做什么 | 规模 |
|---|---|---|---|
| `feat/ui-office-preview` | 前端 | 按 spike 的结论接入 Word / Excel / PPT 预览（M3 期间由界面轨道先做） | L |
| `feat/ui-onboarding` | 前端 | 首次使用引导 | M |
| `feat/core-app-integration` | 后端 · Codex | 开机启动、快捷键、检查更新的设置 | M |
| `chore/build-release-pipeline` | 构建 | Tauri updater（更新签名密钥）、公开的更新源（例如单独的公开 releases 仓库）、打 tag 后自动构建 NSIS 安装包并发布的 CI | M |
| `docs/docs-install-guide` | 文档 | 给同学朋友的安装说明，包括 SmartScreen 怎么放行 | S |
| `test/build-release-candidate` | 测试 | Windows 10 和多显示器缩放；全量无障碍审查；5 万文件 / 100 GB 的性能复核；整个 IPC 面的 `/security-review`；`engineering:deploy-checklist` | M |
| 试用 | — | 2～3 位同学试用 → 修问题 → v1.0 | — |

## 6. 需要你做的事和决定

| 时间 | 事项 | 类型 | 状态 |
|---|---|---|---|
| 阶段 0 | 批准 ADR-0004 | 批准 | 已完成（2026-09-28） |
| 阶段 0 | 批准阶段 0 的合并顺序 | 批准 | 已完成，4 个 stack 已合并 |
| 阶段 0 | 同意 Tauri 2.12 升级，手动检查窗口 | 批准、手动 | 已完成，手动检查通过 |
| 阶段 0 | Codex 只做后端编码 | 决定 | 已完成（写在 `AGENTS.md`） |
| 阶段 0 | 批准步骤 0.5：Claude 评审后合并 Tauri 升级；合并三个文档分支 | 批准 | 已完成 |
| 现在 | §2 的版本定义和 M1→M4 的顺序（brief §11 仍是「待确认」） | 决定 | 没有单独确认；本文按它执行，有异议随时改 |
| M1 期间，越早越好 | 升级 iCloud for Windows | 手动 | 待做 |
| M1 第 1 波 | 给 Office spike 准备一批真实课程文件（含中文 PPT） | 手动 | 已完成（用了 一门课的英文课件和一份 iCloud 里的中文 PPT） |
| M1 同步点 1 | 批准 ADR-0005 界面架构 | 批准 | 已完成（2026-09-28）：笔记旁边的图片 M1 就做；预览里的链接只显示地址；v0.1 的方块栏只有 Library；新开 `feat/ui-data-layer` |
| M1 同步点 1 | 审阅 Cowork 的首次使用和资料库操作设计 | 决定 | 已完成，已合并 |
| M1 同步点 1 | PPT 预览做到什么程度 | 决定 | 已完成：选 A（正常渲染，提示可能与 PowerPoint 略有不同），记在 ADR-0001 行动项 4c |
| M1 同步点 1 | 批准合并设计、spike 和 `feat/core-library-state`，以及装 M1 界面依赖 | 批准 | 已完成 |
| M1 第 2 波 | 批准课程编号等对 ADR-0002 的修订；移动操作的崩溃恢复扩展 | 批准 | 已完成（9-29、9-30） |
| 现在（同步点 2） | 批准合并 CI 修复、日志、library-ops 和 browse | 批准 | 待定（附录 A.11～A.14 的提示里写了你的批准，评审通过才合并） |
| M2 之前 | 批准 `remote-format.md`：云端格式一旦有了真实数据就很难再改 | 批准 | 待定 |
| M3 之前 | 准备第二台 Windows 设备（或虚拟机）做双设备测试 | 手动 | 待做 |
| M4 之前 | 更新源放在哪；要不要代码签名（Windows 11 的「智能应用控制」会直接拦截未签名的程序，三个方案见 ADR-0001 行动项 6） | 决定 | 待定 |

## 7. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 合并积压、并行 lane 改同一段文件 | 分支互相卡住，合并时冲突 | §4 的规则；第 1 波先拆 IPC 注册和语言文件 |
| PPT 渲染器还不成熟 | M4 的 Office 预览达不到 brief 的描述 | M1 就做 spike，预留降级方案 |
| iCloud for Windows 的实际行为和文档不一致 | 同步丢改动，或出现冲突副本 | M3 实现前先实测和仿真；覆盖前先导入；删除只进回收站 |
| 只有一台 Windows 电脑 | 测不到双设备同步 | 虚拟机，或借一台电脑 |
| 未签名分发 | 朋友的电脑拦截安装 | M4 之前定下签名方案 |
| tauri-specta 仍是 rc，版本固定 | 升级 Tauri 时绑定生成可能出问题 | 每次升级都走单独的依赖 lane，由 `export_bindings` 测试把关 |
| 共用 `target/` 和 dev server | 并行 session 互相拖慢，基准测试不准 | 同时最多 3 个 Rust session；基准测试找安静的时候跑 |
| Codex 和 Claude 的规则再次分叉 | 两边记录位置、界面语言等不一致，互相看不到占用 | `AGENTS.md` 只指向 `CLAUDE.md`、不再抄写规则；改 `CLAUDE.md` 协作规则的 lane 顺带检查 `AGENTS.md` |

## 附录 A：下一批 lane 的启动提示

按 CLAUDE.md §2，给 agent 的提示用英文，直接粘贴。Claude Code 在 `Folio/` 里打开；Codex 在上级目录 `Documents Manage` 里打开，提示开头加 A.0。编号接着上一批往下排，用完的 A.1～A.10 在 git 历史里（`1293648`）；第 4 波和 M1 验收的提示在第 3 波合并后补上。开法和能并行的组合见 §5 的「下一阶段可以并行的任务」。

`pnpm e2e` 一次只能有一个 session 跑：先拿 app lock（CLAUDE.md §7.5），跑完释放。

### A.0 交给 Codex 时加在提示开头

```text
Codex: follow Documents Manage/AGENTS.md and Folio/CLAUDE.md. Backend coding only: lane file in Folio/.agents/lanes/, specs and ADRs in Folio/docs/, scratch in folio-agent-work/tasks/<lane>/. Map the Claude skill names below to your skills in AGENTS.md §5. Stop at review and write the review scope into folio-agent-work/tasks/<lane>/claude-review-handoff.md; a Claude Code session runs /code-review, /security-review and /simplify before I approve the land.
```

### A.11 同步点 2：合并 CI 修复

```text
Folio: sync point 2, step 1 (docs/product/roadmap.md §5 M1, appendix A.11): land fix/build-ci-access-violation so CI on main goes green again, then the roadmap update docs/docs-roadmap-wave3. I approve landing both.
1. Read CLAUDE.md §7, every file in .agents/lanes/ and .agents/lanes/fix--build-ci-access-violation.md; run `but status` and `but pull --check`.
2. Its reviews are done and the fix passed CI on a probe run, but the later /simplify cleanup was checked locally only: take the app lock (CLAUDE.md §7.5), run `pnpm check` and `pnpm e2e`, release the lock.
3. Land with `but land fix/build-ci-access-violation --yes`, then `but land docs/docs-roadmap-wave3 --yes` (docs only), with `but status` after each, and delete both lane files. Stop at the first conflict or failure and report it; never use --ai.
4. Follow the CI run for the push to main until it finishes. If it is red, find out why and report before anything else lands.
Report to me in Chinese.
```

### A.12 同步点 2：评审并合并 `chore/core-logging`

```text
Folio: sync point 2, review of chore/core-logging (docs/product/roadmap.md §5 M1, appendix A.12). Codex finished the lane; I approve landing it once your reviews pass and the checks are green.
1. Read CLAUDE.md, every file in .agents/lanes/, .agents/lanes/chore--core-logging.md and ../folio-agent-work/tasks/chore-core-logging/verification-and-handoff.md (the review scope). Run `but status` and `but pull --check`. Land only after fix/build-ci-access-violation (appendix A.11) is on main.
2. Take over the lane for review: /code-review, /security-review and /simplify on its commit, with attention to what the UI can write into the log (size, rate limit, validation on the privileged side, no file contents), retention and pruning (never outside the logs folder, symlinks, future dates) and swallowed errors. Fix findings with commits on the branch; stop and ask me if a finding needs a product or security decision.
3. Take the app lock (CLAUDE.md §7.5), run `pnpm check` and `pnpm e2e`, release the lock. apps/desktop/src/ipc/bindings.ts must stay unchanged.
4. Land one lane at a time (roadmap §4 rule 10): check that no other lane is landing and every other lane is checkpoint or review, then `but land chore/core-logging --yes`, `but status`, delete the lane file and check the CI run on main. Stop at the first conflict or failure and report it; never use --ai.
Report to me in Chinese.
```

### A.13 同步点 2：评审并合并 `feat/core-library-ops`

```text
Folio: sync point 2, review of feat/core-library-ops (docs/product/roadmap.md §5 M1, appendix A.13). Codex finished the lane (three commits, about 8,100 lines); I approve landing it once your reviews pass and the checks are green.
1. Read CLAUDE.md, every file in .agents/lanes/, .agents/lanes/feat--core-library-ops.md and ../folio-agent-work/tasks/feat-core-library-ops/claude-review-handoff.md (the review scope and focus list), then final-review.md and independent-review.md there. Read the approved amendments in ADR-0002 and docs/specs/library-core.md. Run `but status` and `but pull --check`. Land only after fix/build-ci-access-violation (appendix A.11) is on main.
2. Take over the lane for review: /code-review at high effort, /security-review and /simplify on its three commits. Focus on the handoff's list: the separate recovery commit and its publication, before/after image conflicts and interrupted restoration, case-only spelling, retained IDs, hashes and bodies, fallible response mapping, the full-walk operation lock, retry generation and shutdown, Recycle Bin only (never a permanent delete), and reading metadata format 1 and journal versions before 3. Fix findings with commits on the branch; stop and ask me if a finding needs a product or security decision.
3. Take the app lock (CLAUDE.md §7.5), run `pnpm check` and `pnpm e2e`, release the lock. apps/desktop/src/ipc/bindings.ts must stay unchanged.
4. Add a progress line to ADR-0004 action item 3 and mark item 3 of docs/specs/ipc-m1.md §21 as done, if the lane has not.
5. Land one lane at a time (roadmap §4 rule 10): `but land feat/core-library-ops --yes`, `but status`, delete the lane file and check the CI run on main. Stop at the first conflict or failure and report it; never use --ai.
Report to me in Chinese, including the frontend hand-off in the lane file.
```

### A.14 同步点 2：评审并合并 `feat/data-browse-queries`

```text
Folio: sync point 2, review of feat/data-browse-queries (docs/product/roadmap.md §5 M1, appendix A.14). Codex finished the lane (one commit, about 4,500 lines); I approve landing it once your reviews pass and the checks are green.
1. Read CLAUDE.md, every file in .agents/lanes/, .agents/lanes/feat--data-browse-queries.md and ../folio-agent-work/tasks/feat-data-browse-queries/claude-review-handoff.md (the review scope), then snapshot-decision.md, snippet-decision.md and frontend-handoff.md there. Run `but status` and `but pull --check`. Land after fix/build-ci-access-violation and, if it is ready, after feat/core-library-ops: both change crates/folio-app/src/library/mod.rs and worker.rs.
2. Take over the lane for review: /code-review at high effort, /security-review and /simplify on its commit. Focus on exact ID-and-path references, all-tag, inheritance and scope semantics, empty and out-of-range pages, the fixed search window and its time anchor, the commit and read lock order on shutdown and switch, bind-only SQL, plain-text highlights, resolve_paths' lexical confinement (no absolute paths, schemes or root escape), and the new FTS5 callback in queries/snippet.rs (ABI, context and text lifetimes, panic containment, oversized bodies). Fix findings with commits on the branch; stop and ask me if a finding needs a product or security decision.
3. Take the app lock (CLAUDE.md §7.5), run `pnpm check` and `pnpm e2e`, release the lock. apps/desktop/src/ipc/bindings.ts must stay unchanged.
4. Add a progress line to ADR-0004 action item 3 and mark item 2 of docs/specs/ipc-m1.md §21 as done, if the lane has not.
5. Land one lane at a time (roadmap §4 rule 10): `but land feat/data-browse-queries --yes`, `but status`, delete the lane file and check the CI run on main. Stop at the first conflict or failure and report it; never use --ai.
Report to me in Chinese.
```

### A.15 同步点 2：`feat/ui-data-m1-hooks`

```text
Folio lane feat/ui-data-m1-hooks (docs/product/roadmap.md §5 M1 sync point 2, appendix A.15). Front end and small: start now, in parallel with the reviews, and land it early, since the four wave 3 view lanes start from it.
Read docs/specs/ui-architecture.md §4 (one data file per command group), §5 (data layer) and §11 (fake shell), docs/specs/ipc-m1.md §6–§12, and the existing apps/desktop/src/data/ (library.ts, entries.ts, jobs.ts, problems.ts, keys.ts, paged.ts, references.ts).
Goal: the data hooks the views share: groups.ts (semester and course lists and mutations), tags.ts (list, create, update, reorder, delete, set_entry_tags), the entry mutations (create_folder, rename_entry, move_entries, delete_entries) with their CatalogChanged handling, search.ts (pages over the fixed window), files.ts (open_entry, reveal_entry, resolve_paths), the library choices in library.ts (pick_library_folder, create_library, open_library), and import.ts (pick_import_files, check_import, import_files, against the fake shell until feat/core-import lands). Batch results keep every failed item, and errors stay typed (CLAUDE.md §5).
Own only these data files and their tests; no views. Unit tests against the fake shell for every hook, including revisions, partial batch failures and stale references; `pnpm check`, /code-review, /simplify; report to me in Chinese.
```

### A.16 第 3 波：`feat/ui-library-view`

```text
Folio lane feat/ui-library-view (docs/product/roadmap.md §5 M1 wave 3, appendix A.16). Start after feat/ui-data-m1-hooks has landed; build against the fake shell, and run the real-app e2e once feat/core-library-ops and feat/data-browse-queries are on main. Use frontend-design.
Read docs/design/handoff/app-shell.md §3 and §5 (toolbar, Library view), docs/design/handoff/library-actions.md (§6 context menus; §7 rename, new folder, move, delete; §8 empty states; §9 error states; §12 keyboard; §14 narrow window; §16 items 6 and 8), docs/specs/ui-architecture.md (§6, §7, §8.2 the tree as a flat list, §13, §17 item 3), ADR-0005, and the backend hand-offs: ../folio-agent-work/tasks/feat-data-browse-queries/frontend-handoff.md and the hand-off in feat/core-library-ops's lane file (or its commit message once landed).
Goal: the Library view, replacing PlaceholderLibrary in app/registry.ts: the course tree (courses, folders, files; a semester's loose files after its courses), tag filter chips (every selected tag must match), Recently added and Untagged, list and grid with sorting, the semester switcher if the toolbar does not have it yet, selection and multi-select, new folder, rename, move between courses, delete to the Recycle Bin, batch tagging, context menus, and every empty and error state of the specs. The third column hosts feat/ui-preview's pane once it lands; until then, its empty state.
Own apps/desktop/src/library/** and the library namespace; app/registry.ts and other app/ files get one-line additive edits. Component tests for every state the specs name, a Playwright flow, design:design-critique and design:accessibility-review on the built screen (run + browser pane), a reduced-motion check, `pnpm check` and `pnpm e2e` with the app lock, /code-review, /simplify; report to me in Chinese.
```

### A.17 第 3 波：`feat/ui-preview`

```text
Folio lane feat/ui-preview (docs/product/roadmap.md §5 M1 wave 3, appendix A.17). Start after feat/ui-data-m1-hooks has landed; build against the fake shell, and run the real-app e2e once feat/data-browse-queries is on main (feat/core-file-scheme already is). Use frontend-design.
Read docs/specs/ui-architecture.md §10 (where each type renders, the frame, the protocol, the renderers, keyboard and focus), §14, §17 items 1 and 2 and §18; ADR-0005 (product decisions 1 and 2); ADR-0001 action items 4c and 5 (Office choice, preview sandbox); docs/design/handoff/app-shell.md §5 (the preview pane) and library-actions.md §9.2–§9.3; docs/specs/ipc-m1.md §11 with the failure reasons the contract fix added.
Goal: the preview pane: images, PDF with pdf.js, Markdown with maths, code highlighting, sanitised HTML and images next to the note (resolve_paths), code and plain text, audio and video, and the card for other files; links show their address and can be copied, never opened; the header with tags and the Open and Show in File Explorer actions; one fresh frame per file; the frame protocol. Office files show the "Open with default app" card in M1 (their renderers come with feat/ui-office-preview in M4). Settle ui-architecture §17 items 1 and 2 (the pdf.js worker in the sandboxed frame, Temml on real notes) and check HEIC.
Add `worker-src blob:` and `'wasm-unsafe-eval'` to the preview CSP in crates/folio-app/src/preview.rs and nowhere else; the preview-sandbox e2e tests must still pass, and that change gets /security-review. Own apps/desktop/src/preview/** (move src/preview/frame.ts into src/preview/frame/), preview.rs and the preview namespace. Component tests, a Playwright flow per renderer family, design:design-critique and design:accessibility-review, a reduced-motion check, `pnpm check` and `pnpm e2e` with the app lock, /code-review, /security-review, /simplify; report to me in Chinese.
```

### A.18 第 3 波：`feat/ui-search-palette`

```text
Folio lane feat/ui-search-palette (docs/product/roadmap.md §5 M1 wave 3, appendix A.18). Start after feat/ui-data-m1-hooks has landed; build against the fake shell, and run the real-app e2e once feat/data-browse-queries is on main. Use frontend-design.
Read docs/design/handoff/app-shell.md §8 (search), docs/specs/ui-architecture.md §9 and §14, docs/specs/ipc-m1.md §10, the browse hand-off (../folio-agent-work/tasks/feat-data-browse-queries/frontend-handoff.md: the fixed 500-result window, QueryTooLong, plain-text spans), and app/registry.ts and app/navigation.ts (registering the search dialog shows the toolbar button and Ctrl+K).
Goal: the Ctrl+K palette: results as you type, grouped, highlights rendered as text from the spans (never innerHTML), arrow keys, Enter selecting the file in the Library view and opening its preview through the navigation store, Escape, and the empty, too-long and error states.
Own apps/desktop/src/search/** and the search namespace; app/registry.ts gets a one-line edit. Component tests, a Playwright flow, keyboard and screen-reader checks with design:accessibility-review, design:design-critique, a reduced-motion check, `pnpm check` and `pnpm e2e` with the app lock, /code-review, /simplify; report to me in Chinese.
```

### A.19 第 3 波：`feat/ui-first-run`

```text
Folio lane feat/ui-first-run (docs/product/roadmap.md §5 M1 wave 3, appendix A.19; moved up from wave 4). Start after feat/ui-data-m1-hooks has landed; build against the fake shell's first-run fixture, and run the real-app e2e once feat/core-library-ops is on main. Use frontend-design.
Read docs/design/handoff/first-run.md (all of it), library-actions.md §2 (shared components), docs/specs/library-state.md, docs/specs/ipc-m1.md §6 and §7 (library states, incomplete libraries, the unavailable reasons and the retry the contract fix added) and docs/specs/ui-architecture.md §6.1 (the current semester per library).
Goal: the first-run flow the app shows while library_status has no library: welcome, choosing a folder (new library or taking over one), the library name, the first semester and courses with row-by-row failures (first-run.md §5), and the library-unavailable screen with Try again. Drive the native folder dialog by hand once in the real app (no lane has yet) and note the result in your lane file.
If feat/core-discard-move (A.24) has landed, the library-unavailable screen also offers its confirmed "discard the unfinished move" action for the reason it adds (copy with design:ux-copy); if not, note it in your lane file as open.
Own apps/desktop/src/first-run/** and the first-run namespace; app/ gets small additive edits to show the flow. Component tests for every state first-run.md names, a Playwright flow in a temporary folder, design:design-critique and design:accessibility-review, a reduced-motion check, `pnpm check` and `pnpm e2e` with the app lock, /code-review, /simplify; report to me in Chinese.
```

### A.20 第 3 波：`feat/core-import`（可交给 Codex）

```text
Folio lane feat/core-import (docs/product/roadmap.md §5 M1 wave 3, appendix A.20). Start after feat/core-library-ops has landed, when fewer than three sessions are building Rust.
Read docs/specs/ipc-m1.md §4.2 (user choices), §12 (import), §17 and §20, ADR-0004 (options 2 and 5, action item 6), docs/specs/library-state.md (jobs, command ownership), docs/specs/windows-adapter.md §4 (Recycle Bin), and what the UI expects in docs/design/handoff/library-actions.md §3–§5 and §16 items 1 and 2.
Goal: the last three M1 commands: pick_import_files, check_import (with folder flags) and import_files as a job with progress, copying into a course with tags, the one name-clash choice (replace, keep both, skip), and optionally moving the originals to the Recycle Bin; native file drops through the shell with single-use tokens (dragDropEnabled, the FilesDropped and DropHover events) and the replacement for the test main_window_does_not_publish_native_drag_paths. Settle whether ImportResult.imported includes replaced and renamed files and write it into ipc-m1 §12. With the last planned command gone, follow the note at the top of crates/folio-app/src/ipc.rs (make the modules private again) and keep e2e/tests/ipc-planned.spec.ts meaningful (an unknown command is still rejected).
Start with engineering:system-design. Own your command group and an import module in folio-core. Contract tests, crash and partial-failure tests (disk full, a file in use), `pnpm check` and `pnpm e2e` with the app lock, /code-review, /security-review (outside paths enter the privileged layer), /simplify; report to me in Chinese.
```

### A.21 第 3 波：`feat/core-app-settings`

```text
Folio lane feat/core-app-settings (docs/product/roadmap.md §5 M1 wave 3, appendix A.21). Contract and implementation in one small lane; start when fewer than three sessions are building Rust.
Read docs/specs/ipc-m1.md §1 (settings were left for a later contract), docs/specs/library-state.md (the per-machine settings file), docs/specs/system-overview.md §5, ADR-0002 §3 (`.folio/ignore`), docs/design/handoff/app-shell.md §9 (the two settings dialogs), docs/specs/ui-architecture.md §6.3 (theme and motion) and apps/desktop/src/app/appearance.ts.
Goal: the settings M1 needs: the device name, appearance (System, Light, Dark), reduce motion, and the library's ignore rules (a change starts a rescan), with get and set commands, validation on the privileged side and an event when they change. Write the contract into ipc-m1 (a new section, and §20), regenerate the bindings and, in the same lane, update the fake shell in apps/desktop/src/ipc/mock/ and its fingerprint (roadmap §4 rule 2). If appearance.ts keeps the theme somewhere temporary today, wire it to the stored setting.
Start with engineering:system-design. Own the settings command group, settings.rs and the fake shell's settings file. Contract tests, `pnpm check` and `pnpm e2e` with the app lock, /code-review, /security-review, /simplify; report to me in Chinese.
```

### A.22 第 3 波：`chore/core-webview-accelerator-keys`（可交给 Codex）

```text
Folio lane chore/core-webview-accelerator-keys (docs/product/roadmap.md §5 M1 wave 3, appendix A.22). Small; start when fewer than three sessions are building Rust.
Read docs/specs/ui-architecture.md §6.4 and §17 item 4. Goal: in release builds only, turn off WebView2's browser accelerator keys (reload, find, print and the like) with ICoreWebView2Settings3::SetAreBrowserAcceleratorKeysEnabled(false) through WebviewWindow::with_webview before the first navigation; debug builds and e2e keep them. webview2-com is already in the lockfile through wry: add it as a direct dependency at the locked version, so nothing new is downloaded. The app's own shortcuts (Ctrl+K, Ctrl+1, Ctrl+,) must still reach the page; record the result in ui-architecture §17 item 4.
Own the window set-up in folio-app and its test. A manual check in a release build, `pnpm check` and `pnpm e2e` with the app lock, /code-review, /security-review, /simplify; report to me in Chinese.
```

### A.23 第 3 波：`refactor/core-sta-helper`（可交给 Codex）

```text
Folio lane refactor/core-sta-helper (docs/product/roadmap.md §5 M1 wave 3, appendix A.23). Small; start after fix/build-ci-access-violation and feat/core-library-ops have landed, when fewer than three sessions are building Rust.
Two near-identical helpers run work on a single-threaded apartment: `in_sta` in crates/folio-app/src/dialogs.rs and `in_apartment` in folio-core's win::recycle. Keep one, in folio-core's win module, and use it from both, without changing behaviour: the CI fix's rule (docs/specs/windows-adapter.md §4: hold the process MTA so a teardown never unloads a cached WinRT factory) and the Recycle Bin's COM threading stay as they are. The CI fix's commit "fix(app): keep COM initialized so cached WinRT factories stay valid" explains the rule.
Own the two files and the shared helper. Tests for both callers, `pnpm check` and `pnpm e2e` with the app lock, /code-review, /simplify; after landing, check that the CI run on main (Windows Server 2022, where the crash showed) is green. Report to me in Chinese.
```

### A.24 第 3 波：`feat/core-discard-move`

```text
Folio lane feat/core-discard-move (docs/product/roadmap.md §5 M1 wave 3, appendix A.24). Contract and implementation in one small lane; start after feat/core-library-ops has landed, when fewer than three sessions are building Rust.
Read docs/specs/library-scan.md §7.1 (the move intent and its recovery), docs/specs/library-state.md (recovery, the unavailable reasons, and Sirui's decision of 2026-09-30 on discarding an unfinished move), docs/specs/ipc-m1.md §6 and §20, ADR-0002 §1, and Library::recover_pending in crates/folio-core/src/library/mod.rs with ScanJournal in meta/tree.rs.
Goal: when the intent of an in-app move that a crash interrupted can no longer be reconciled (its files, folders or metadata changed, or the catalog was recreated), library_status says so with an unavailable reason of its own instead of catalogFailed, and a confirmed command discards the move. Discarding never moves or deletes the user's files and never overwrites an authored metadata file that no longer matches the journal's images; it removes the journal, and a full scan rebuilds the catalog from the disk and the authored metadata. Write the contract into ipc-m1 (§6 and §20), regenerate the bindings and, in the same lane, update the fake shell in apps/desktop/src/ipc/mock/ and its fingerprint (roadmap §4 rule 2). Tell feat/ui-first-run (A.19) the reason and the command: the button belongs on its library-unavailable screen.
Start with engineering:system-design. Own the new command, its manifest and capability lines, and the discard function in folio-core's library module. Contract tests, crash tests (a discard interrupted halfway, a conflicting metadata file), `pnpm check` and `pnpm e2e` with the app lock, /code-review, /security-review, /simplify; report to me in Chinese.
```
