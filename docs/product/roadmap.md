# Folio 上线路线图（到 v1.0）

> **状态**：v0.2，阶段 0 基本完成，M1 第 1 波可以开始 · **更新**：2026-09-28 · **决策人**：Sirui · **整理**：Claude Code
>
> 依据：产品简介 [`brief.md`](brief.md) §10–§11，四份 ADR 的行动项，各 spec 的 "Next lanes" 一节，`.agents/lanes/` 里的 lane 文件和 `but status`（2026-09-28）。每一波开始前更新本文：勾掉完成的 lane，补上下一波的启动提示。

## 1. 结论

- **现在在哪**：阶段 0 基本完成（2026-09-28）。原来排队的 4 个 stack 已合并，main 上的 CI 通过；M1 的**底层**已全部在 main 上：核心库（路径、元数据、catalog、中文搜索、扫描与对账）、Windows 适配（文件 ID、回收站、文件监视）、M1 的 IPC 合约（ADR-0004 已接受）、设计基础（token 和界面规格）。Tauri 已升到 2.12（Codex 完成，你手动检查通过），但还缺 Claude Code 评审、没有合并。M1 的**功能层**还没开始：35 个 M1 命令只有声明、没有实现，界面只有标题栏。
- **开始第 1 波之前**：一个 Claude Code session 评审并合并 Tauri 升级，再合并三个文档分支（§5 步骤 0.5，附录 A.1）。不碰 Cargo 和 lockfile 的第 1 波 lane（界面架构 ADR、Office spike、Cowork 设计、英文界面）现在就可以同时开始；`feat/core-library-state` 等 0.5 合并后再开。
- **还剩多少**：到 v1.0 大约 55 个 lane：M1 约 19 个，M2 约 14 个，M3 约 15 个，M4 约 6 个。按「核心 / 界面 / 设计 / 验证」四条轨道并行，同一时间 3～5 个 lane。
- **分工**（每个 lane 在表里标了「分工」，说明见 §4.1）：Codex 只做后端编码（你 2026-09-28 的决定，写在上级目录的 `AGENTS.md`），约 22 个后端 lane 可以交给 **Codex**；19 个前端 lane，以及 10 个规格、合约、前端依赖、发布、实测和说明文档 lane 由 Claude Code 做；3 个设计 lane 由 Cowork 做。
- **需要你现在决定**：批准步骤 0.5 的两次合并。§2 的版本定义和 M1→M4 的顺序没有单独确认过，本文按它执行，有异议随时改。完整清单见 §6。

## 2. 「上线」指什么（建议）

brief §11 把 M4 定为「可以发给同学朋友用」，所以本文把 **v1.0 = M4 完成、发给同学朋友** 当作上线。每个里程碑之后先出一个只给你自己用的版本，尽早真正用起来：

| 版本 | 完成的里程碑 | 谁用 | 能做什么 |
|---|---|---|---|
| v0.1 | M1 本地资料库 | 你自己（先在资料库的副本上用） | 日常替代资源管理器：浏览、标签、搜索、预览、导入 |
| v0.2 | M2 版本记录 | 你自己 | 提交、历史、文本和 Word 的差异与恢复、正文搜索 |
| v0.3 | M3 云端同步 | 你自己，从这里开始「连续用一整个学期」的实测（brief §10） | iCloud 云端仓库、同步、冲突处理 |
| v1.0 | M4 打磨与分发 | 同学朋友 | Office 预览、安装包、自动更新、首次使用引导 |

## 3. 当前进度（2026-09-28，阶段 0 之后）

### 3.1 已在 main 上（74 个提交，CI 通过）

| 方面 | 内容 |
|---|---|
| 产品与决策 | brief v0.3（英文界面、课程编号、新布局）；ADR-0001 技术栈、ADR-0002 数据存储、ADR-0003 版本与同步格式、ADR-0004 M1 IPC 合约均已接受；system overview、testing strategy |
| 工程底座 | Tauri 2 + React + Rust 工作区；类型化 IPC（tauri-specta）；Playwright 通过 WebView2 CDP 跑 e2e；GitHub Actions CI（windows-2022） |
| 技术验证 | 自绘标题栏 + Windows 11 贴靠布局（ADR-0001 4b，含顶部缩放边和读屏修复）；预览沙箱 iframe（安全基线）；中文分词器 `folio_cjk`（5 万条目上一页结果 1～81 ms）；tauri-specta 端到端（4d）；CI 上的 e2e（4a） |
| 核心库 `folio-core` | 库内路径和 Windows 命名规则；`.folio/` 元数据读写；SQLite catalog（迁移、恢复）；排序搜索和高亮；扫描与对账（标签跟着文件移动、忽略规则、哈希）；5 万文件的扫描基准 |
| Windows 适配 | NTFS 文件 ID 和 iCloud 占位文件识别；只进回收站、绝不永久删除；文件监视和防抖的局部重扫 |
| IPC 合约 | M1 的 35 个命令、事件和错误的类型；生成的 bindings 和界面侧封装；planned 命令只声明、不注册 |
| 设计基础 | 设计 token（浅色和深色）、app-shell 界面规格；从 token 生成的 CSS |

### 3.2 等合并（2 组）

| 分支（stack 从下到上） | 提交 | 内容 | 还差什么 |
|---|---|---|---|
| `chore/build-deps-tauri-2-12` | 1 | Tauri 2.12.0（Codex 完成）：`pnpm check` 和 e2e 11/11 通过，你手动检查了贴靠布局、最大化还原和拖动窗口 | Claude Code 的 `/code-review`、`/security-review`、`/simplify`；ADR-0001 行动项 3 还没改；你批准合并 |
| `docs/docs-roadmap-v1` → `docs/docs-retire-work-packages` → `docs/docs-roadmap-wave1` | 3 | 本路线图；退役工作包、app lock 移到 `.agents/locks/`；阶段 0 之后的这次更新 | 你批准，`--whole-stack` 一起合并 |

### 3.3 还没开始的

- **M1 功能层**：35 个 planned 命令都没有实现（真正运行的只有 `app_info` 和 `set_maximize_button_bounds`）；资料库、搜索、预览、导入、设置、首次使用这些界面都没有。
- **M1 期间该做的验证**：Office 预览（尤其 PPT）的技术验证（ADR-0001 行动项 4c；brief §11 要求在 M1 期间做）。
- **界面架构**：数据缓存、视图切换、无障碍组件、长列表虚拟化都还没有定，也没有 ADR。
- **M2 和 M3 的前置工作**：`remote-format.md` 和 golden vectors（ADR-0003 行动项 2，「M2 之前」）；同步仿真 harness（行动项 3，「M3 之前」）；真实 iCloud 实测（行动项 4）和它的前提——把开发机上的 iCloud for Windows 从 13.4 升级（行动项 5，要你来做）。
- **分发**：更新源、签名方案、安装说明（ADR-0001 行动项 6）。

### 3.4 零散待办（都已归入下面的 lane）

| 来源 | 待办 | 归入 |
|---|---|---|
| WP-04 | Tauri 2.11 → 2.12 | 阶段 0 `chore/build-deps-tauri-2-12`（已完成，待合并） |
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

## 4. 用 GitButler 排任务的规则

来自 CLAUDE.md §7 和这几天的实际情况：23 个提交积压；一个三层 stack 被另一个分支卡住；`feat/ui-i18n-english` 要等两个分支合并才能开始。

1. **先合并，再开新 lane。** review 完的 lane 尽快 land。工作区里同时应用的分支越多，GitButler 的 hunk 依赖和冲突越多。每一波开始前，上一波应基本合并完。
2. **合约先行。** 每个里程碑先有一个 `feat/ipc-mN-contract` lane 定下命令和类型并 land；之后核心 lane 和界面 lane 在 main 上并行，界面用 mock 的 `ipc` 模块开发，不等核心。实现 lane 不改合约；确实要改，就开一个小的合约修正 lane 先合并。
3. **stack 只给真实依赖，最多两层。** 能等上游 land 再开的，就不要 stack。只改文档、一起合并的 stack 例外。
4. **按目录分所有权。** 核心 lane 拥有 `crates/folio-core/src/<模块>/**`，shell lane 拥有 `crates/folio-app/src/<功能>`，界面 lane 拥有 `apps/desktop/src/<视图>/**`。不再让一个 lane 拥有整个 `crates/folio-core/**`。
5. **拆开热点文件。** 并行 lane 最容易在同一段列表上撞车：
   - IPC 注册（`ipc.rs` 里的命令列表、`build.rs`、`capabilities/`）：由 `feat/core-library-state` 先改成每个功能组各自注册、各自一个 capability 文件；
   - 界面文案：由 `feat/ui-i18n-english` 把语言文件按视图拆成 namespace；
   - lockfile：每个里程碑一个 `chore/build-deps-*` lane 集中装依赖（独占操作）。
6. **并行上限：最多 3 个写 Rust 的 session（Claude Code 和 Codex 合计），加 1～2 个界面 session 和 Cowork。** 所有 session 共用一个 `target/` 目录和一个 dev server；跑基准测试要找没有别的构建在跑的时候。
7. **独占操作放在波次之间的「同步点」。** `but land`、`but pull`、装依赖、Tauri 升级都在同步点做；做之前确认其他 lane 都是 `checkpoint`、`review` 或 `done`。
8. **每个 lane 同样收尾。** `pnpm check` + `pnpm e2e` → `/code-review`（改到特权层或 IPC 再加 `/security-review`）→ `/simplify` → 用中文向你汇报 → 你批准 → `but land` → `but status` 确认 → 删 lane 文件。

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
2. **评审由 Claude Code 补。** Codex 用自己的技能先做代码评审和安全评审，但 `CLAUDE.md` 要求的 `/code-review`、`/security-review`、`/simplify` 仍由一个 Claude Code session 在合并前做。Tauri 升级就是这样：Codex 做完停在 review，等 Claude 评审（步骤 0.5）。
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

### 阶段 0：清空合并队列（基本完成）

| 步骤 | 分工 | 做什么 | 状态 |
|---|---|---|---|
| 0.1 | 文档 | 批准 ADR-0004，状态改为 Accepted | 已完成（2026-09-28） |
| 0.2 | 版本管理 | 按顺序 land：① `fix/core-snap-overlay-edges` ② `feat/core-windows-watcher --whole-stack` ③ `feat/ipc-m1-contract` ④ `feat/ui-token-css --whole-stack`；之后删 lane 文件、看 main 上的 CI | 已完成：4 个 stack 已合并，main 上的 CI 通过 |
| 0.3 | 构建 · Codex | `chore/build-deps-tauri-2-12`：Tauri 升到 2.12（原 WP-04，改成普通 lane） | Codex 已完成，检查和你的手动检查都通过；待 0.5 |
| 0.4 | 版本管理 | 整理：WP-03 标为 done；`.agents/work/` 只作只读存档，规则写进 CLAUDE.md §7.7；app lock 移到 `.agents/locks/app`（§7.5） | 已完成，在 `docs/docs-retire-work-packages` 上待合并 |
| 0.5 | 版本管理 | 收尾：Claude Code 评审 Tauri 升级（`/code-review`、`/security-review`、`/simplify`），补上 ADR-0001 行动项 3，合并；再用 `--whole-stack` 合并三个文档分支 | 待做（附录 A.1），需要你批准合并 |

### M1 本地资料库 → v0.1（约 19 个 lane）

**第 1 波**（4 个 lane 加 Cowork 并行，只有一个写 Rust）。ADR-0005、Office spike、Cowork 设计和英文界面不碰 Cargo 和 lockfile，现在就可以开；`feat/core-library-state` 等 0.5 合并后再开，免得它对 Cargo 文件的改动挂在 Tauri 分支上。

| Lane | 分工 | 做什么 | 依赖 | 拥有路径 | 规模 |
|---|---|---|---|---|---|
| `feat/core-library-state` | 后端 · Codex | 先拆 IPC 注册（§4 第 5 条）；设置文件、`LibraryState`、任务注册表和 `JobChanged`；新建、接管、打开资料库；启动扫描和哈希任务；文件监视 → `CatalogChanged`；任务、问题、重建索引的命令（ipc-m1 §21 第 1、6 项） | 步骤 0.5 已合并 | `crates/folio-app/src/` 的状态、任务、命令注册，`build.rs`，`capabilities/`；`folio-core` 里需要的 library 部分 | L |
| `docs/adr-0005-ui-architecture` | 前端（架构） | 界面架构 ADR：数据缓存（按 `CatalogChanged` 的 revision 失效）、视图切换、无障碍组件库、长列表虚拟化、浏览器里用的 mock IPC、目录结构、M1 预览库选型；列出要装的 npm 包 | — | `docs/adr/ADR-0005-*`、`docs/specs/ui-architecture.md` | M |
| `feat/ui-i18n-english` | 前端 | 加 `en` 并设为默认，全部翻译；语言文件按视图拆 namespace；`t()` 的 key 按 `en` 做类型检查；改掉按中文名找按钮的 e2e | —（①③ 已合并） | `apps/desktop/src/i18n/**` | S |
| `spike/ui-office-preview` | 前端（验证） | ADR-0001 4c：用你的真实课程文件（含中文 PPT）比较 docx-preview、SheetJS 和两个 PPT 渲染器，在预览沙箱的 CSP 下测保真度、速度、体积；试验代码放在仓库外，不动 lockfile | — | ADR-0001 的 4c 一项、`docs/research/office-preview-spike.md` | M |
| `design/design-m1-flows` | 设计 · Cowork | 补画 handoff §12 缺的：首次使用（欢迎、新建、接管、建第一个学期和课程）、拖放目标和导入对话框（同名文件：替换 / 都保留 / 跳过）、右键菜单、错误和空状态、任务进度和问题列表 | — | `docs/design/handoff/` 下的新规格、`design/tokens/**` | M |

**同步点 1**：land 第 1 波 → 你批准 ADR-0005 → `chore/build-deps-ui-m1`（构建，Claude Code：一次装齐 M1 界面依赖，独占操作）。

**第 2 波**（3 个核心 lane、1 个界面 lane、1 个小 lane）

| Lane | 分工 | 做什么 | 依赖 | 拥有路径 | 规模 |
|---|---|---|---|---|---|
| `feat/data-browse-queries` | 后端 · Codex | 树、列表、网格的查询（自然排序、继承的标签、多个标签取交集、「最近添加」「未打标签」）和分页搜索，以及对应命令 | library-state | `folio-core` 的查询模块、`folio-app` 的浏览命令 | M |
| `feat/core-library-ops` | 后端 · Codex | 学期、课程、标签、条目的增改删和排序（删除只进回收站）；课程编号等元数据改动，同时修订 ADR-0002 和 library-core（ipc-m1 §20，需你批准） | library-state | `folio-core` 的操作模块和 `meta/model.rs`、`folio-app` 的操作命令 | L |
| `feat/core-file-scheme` | 后端 · Codex | `folio-file` 协议（只读，限定在资料库内）、缩略图缓存、用默认程序打开（从不运行程序或脚本）、在资源管理器中显示；CSP；e2e 证明预览 frame 读不到这个协议 | library-state | `folio-app` 的文件协议、缩略图、打开 | M |
| `feat/ui-app-shell` | 前端 | 窗口骨架：标题栏、工具栏（同步部分先占位）、方块栏、内容区、窄窗口布局；主题和减少动态效果；WebView2 背景色（不闪白）；handoff §10 的共用组件；窗口命令失败的错误状态 | ADR-0005、依赖、i18n | `apps/desktop/src/` 的外壳和共用组件 | L |
| `chore/core-logging` | 后端 · Codex | 正式日志模块替换 `diagnostics.rs` | — | `folio-app` 的日志 | S |

**第 3 波**

| Lane | 分工 | 做什么 | 依赖 | 规模 |
|---|---|---|---|---|
| `feat/core-import` | 后端 · Codex | 选择文件对话框、原生拖放（`dragDropEnabled` 和一次性 token）、`check_import`、带进度的导入任务、可选删除原文件 | library-ops | M |
| `feat/core-app-settings` | 后端（含合约） | M1 要用的本机设置，合约和实现一起：设备名、外观、减少动态效果、忽略规则（ipc-m1 §1 把设置留给了后续合约，这里先做最小的一组） | library-state | S |
| `feat/ui-library-view` | 前端 | 资料库视图：树、标签筛选、快捷视图、列表 / 网格、排序、多选、重命名 / 移动 / 删除、批量打标签、右键菜单 | app-shell、browse、ops | L |
| `feat/ui-search-palette` | 前端 | `Ctrl+K` 搜索：输入即出结果、分组、高亮只当文本渲染、方向键和回车 | app-shell、browse | M |
| `feat/ui-preview` | 前端 | 预览区：图片、PDF（pdf.js）、Markdown（公式、代码高亮、清洗过的 HTML）、代码、音视频、其他；每个文件一个新 frame；验证 HEIC | app-shell、file-scheme | L |

**第 4 波**

| Lane | 分工 | 做什么 | 依赖 | 规模 |
|---|---|---|---|---|
| `feat/ui-import` | 前端 | 拖放目标、「Add files」、导入对话框（标签、同名处理、删除原文件）、进度 | core-import、library-view | M |
| `feat/ui-settings` | 前端 | Library settings（学期、课程、标签、忽略规则、重建索引）和 App settings（设备名、外观、减少动态效果） | app-settings、library-view | M |
| `feat/ui-first-run` | 前端 | 欢迎页 → 新建或接管资料库 → 第一个学期和课程 | library-state、ops、Cowork 设计 | M |

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
| 现在 | 批准步骤 0.5：Claude 评审后合并 Tauri 升级；合并三个文档分支 | 批准 | 待定 |
| 现在 | §2 的版本定义和 M1→M4 的顺序（brief §11 仍是「待确认」） | 决定 | 没有单独确认；本文按它执行，有异议随时改 |
| M1 期间，越早越好 | 升级 iCloud for Windows | 手动 | 待做 |
| M1 第 1 波 | 给 Office spike 准备一批真实课程文件（含中文 PPT） | 手动 | 待做 |
| M1 同步点 1 | 批准 ADR-0005 界面架构 | 批准 | 待定 |
| M1 第 1 波之后 | 审阅 Cowork 的首次使用、导入等设计 | 决定 | 待定 |
| M1 第 1 波之后 | 根据 spike 决定 PPT 预览做到什么程度（不够好就降级为「用默认程序打开」） | 决定 | 待定 |
| M1 第 2 波 | 批准课程编号等对 ADR-0002 的修订 | 批准 | 待定 |
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

按 CLAUDE.md §2，给 agent 的提示用英文，直接粘贴。Claude Code 在 `Folio/` 里打开；Codex 在上级目录 `Documents Manage` 里打开，提示开头加 A.0。第 2 波及以后的提示在第 1 波合并后补上。

第 1 波的开法：

| 什么时候 | Lane | 谁 | 提示 |
|---|---|---|---|
| 现在 | 步骤 0.5：评审并合并 Tauri 升级，合并文档分支 | Claude Code | A.1 |
| 现在，可同时开 | `docs/adr-0005-ui-architecture` | Claude Code | A.3 |
| 现在，可同时开 | `feat/ui-i18n-english` | Claude Code | A.4 |
| 准备好课程文件后 | `spike/ui-office-preview` | Claude Code | A.5 |
| 现在，可同时开 | `design/design-m1-flows` | Cowork | A.6 |
| 0.5 合并之后 | `feat/core-library-state` | Codex（加 A.0）或 Claude Code | A.2 |

`pnpm e2e` 一次只能有一个 session 跑：先拿 app lock（CLAUDE.md §7.5），跑完释放。

### A.0 交给 Codex 时加在提示开头

```text
Codex: follow Documents Manage/AGENTS.md and Folio/CLAUDE.md. Backend coding only: lane file in Folio/.agents/lanes/, specs and ADRs in Folio/docs/, scratch in folio-agent-work/tasks/<lane>/. Map the Claude skill names below to your skills in AGENTS.md §5. Stop at review; a Claude Code session runs /code-review, /security-review and /simplify before I approve the land.
```

### A.1 阶段 0 收尾：评审并合并 Tauri 升级和文档分支

```text
Folio: finish phase 0 (docs/product/roadmap.md §5, step 0.5). I approve landing chore/build-deps-tauri-2-12 once your reviews pass, and the docs stack topped by docs/docs-roadmap-wave1.
1. Read CLAUDE.md §7, every file in .agents/lanes/, and the Tauri lane's evidence: .agents/lanes/chore--build-deps-tauri-2-12.md and ../folio-agent-work/tasks/chore-build-deps-tauri-2-12/review-notes.md. Run `but status` and `but pull --check`.
2. Take over chore/build-deps-tauri-2-12 for review (Codex finished it; its manual window checks passed): run /code-review, /security-review and /simplify on its commit. Fix findings with commits on that branch; stop and ask me if a finding needs a product or security decision.
3. On the same branch, add a result line to ADR-0001 action item 3: Tauri 2.12.0 since 2026-09-28 (lane chore/build-deps-tauri-2-12; the review notes suggest wording).
4. Take the app lock (CLAUDE.md §7.5), run `pnpm check` and `pnpm e2e`, release the lock.
5. Land `but land chore/build-deps-tauri-2-12 --yes`, then `but land docs/docs-roadmap-wave1 --whole-stack --yes`, with `but status` after each. Stop at the first conflict or failure and report it; never use --ai.
6. Delete the landed lane files and check the CI run on main.
Report to me in Chinese.
```

### A.2 第 1 波：`feat/core-library-state`（可交给 Codex）

```text
Folio lane feat/core-library-state (docs/product/roadmap.md §5, M1 wave 1). Start only after roadmap step 0.5 has landed (Tauri 2.12 on main). Read CLAUDE.md, docs/specs/ipc-m1.md (§6, §13–§15, §18, §21 items 1 and 6), ADR-0004, docs/specs/windows-adapter.md §5 and docs/specs/system-overview.md §3.
Goal: the shell holds a LibraryState and runs the library: the per-machine settings file, library_status, pick_library_folder, create_library (new or take over), open_library, the job registry with JobChanged, the start-up scan and hashing jobs, the watcher's scoped rescans feeding CatalogChanged, list_jobs, cancel_job, rebuild_catalog, list_problems.
Do this first, before adding commands: restructure command registration so that each feature group registers its commands, lists them for build.rs and grants them (one capability file per group in capabilities/) in files of its own, keeping runtime_commands_are_declared_and_granted and the no-default-sets test. Later lanes (browse, operations, file scheme, import) must then touch only their own files.
Start with engineering:system-design (LibraryState, threads, the job registry, shutdown) and write docs/specs/library-state.md. The shell owns closing the window, so a page cannot veto it: now that background jobs exist, closing must cancel or finish them without leaving half a write (roadmap §3.4). Contract tests for every command, an e2e test that creates a library in a temporary folder and sees an outside change arrive (take the app lock for pnpm e2e, CLAUDE.md §7.5), /code-review, /security-review, /simplify. Follow the lane protocol in CLAUDE.md §7.3; own only the paths you list in the lane file. Report to me in Chinese.
```

### A.3 第 1 波：`docs/adr-0005-ui-architecture`

```text
Folio lane docs/adr-0005-ui-architecture (docs/product/roadmap.md §5, M1 wave 1). Before any view is built, decide the UI architecture with engineering:system-design and then engineering:architecture, as ADR-0005 (Proposed; I approve) plus docs/specs/ui-architecture.md. Inputs: docs/design/handoff/app-shell.md (§10 shared components, §11 build requirements), ADR-0004, docs/specs/ipc-m1.md §15, ADR-0001 (preview renderers, security baseline), docs/specs/library-core.md §6 (search highlights are rendered as text).
Decide: the data layer (pages cached by request and invalidated by CatalogChanged revisions: a library such as TanStack Query or our own); view state and switching between rail views; accessible primitives for the tree, listbox, dialogs, menus and tooltips (e.g. React Aria, Radix or our own) against handoff §11; list virtualisation for 50,000 rows; a mocked ipc module for the browser pane and component tests; folder layout per view; the M1 preview libraries (pdf.js, Markdown with maths and highlighting, the HTML sanitiser). The i18n structure (en as default, one namespace per view) is set by the parallel lane feat/ui-i18n-english: read its lane file and describe it, do not decide it again.
List the npm packages to add, each with a version at least one day old, for the later chore/build-deps-ui-m1 lane; do not install anything. Summarise the decisions for me in Chinese with options where the choice is mine.
```

### A.4 第 1 波：`feat/ui-i18n-english`

```text
Folio lane feat/ui-i18n-english (docs/product/roadmap.md §5, M1 wave 1; follow-up 2 in the design-foundation lane notes; the lanes it waited for have landed).
Add the en locale as the default and translate every string, using the English source copy in docs/design/handoff/app-shell.md where it exists. Split the locale files into namespaces (common, errors, titlebar, and one per view to come), so that parallel UI lanes add strings in different files; the parallel lane docs/adr-0005-ui-architecture describes this structure, so keep your lane file's notes on it current. Type t() keys against en. Decide with a short note whether zh-CN stays as a second locale until the Chinese UI version. Update the e2e tests that find elements by zh-CN names, the i18n check in docs/specs/testing-strategy.md and the last sentence of CLAUDE.md §2 (small edits). Take the app lock for pnpm e2e (CLAUDE.md §7.5). /code-review and /simplify; report to me in Chinese.
```

### A.5 第 1 波：`spike/ui-office-preview`

```text
Folio lane spike/ui-office-preview (ADR-0001 action item 4c; brief §11 asks for it during M1). Timebox: one session. I will give you a folder of real course files (.docx, .xlsx, .pptx, including Chinese decks). Render them with the candidates in ADR-0001 "Preview renderers" (docx-preview, SheetJS CE, @aiden0z/pptx-renderer, pptx-viewer-core) under the preview frame's CSP (no eval, no inline script, no network). Build the spike outside the repository, in your scratchpad, so the shared lockfile and node_modules stay untouched; every package at least one day old.
Measure fidelity (side by side with PDFs I export from Office), time to first render, bundle size, licence and maintenance. Commit only the result: ADR-0001 item 4c, and a Chinese comparison with screenshots and a recommendation in docs/research/office-preview-spike.md, including a fallback (text only, or "Open with default app"). Report to me in Chinese.
```

### A.6 第 1 波：Cowork `design/design-m1-flows`

```text
Cowork lane design/design-m1-flows (docs/product/roadmap.md §5, M1 wave 1). Handoff specs for the M1 flows that docs/design/handoff/app-shell.md §12 item 2 leaves undrawn: first run (welcome, new library, take over a folder, first semester and courses; brief §7 item 1); the drop target and the import dialog (tags, the one choice for name clashes: replace, keep both, skip; delete originals; docs/specs/ipc-m1.md §12); context menus for tree items and rows; error and empty states, including failed window commands; job progress and the problems list.
Work on the Design canvas "Folio 设计基础" with the tokens in design/tokens/ and the Design System artifact; critique and accessibility pass by hand as in app-shell.md §11; English UI copy. Write docs/design/handoff/first-run.md and docs/design/handoff/library-actions.md; add tokens only in design/tokens/. Hand off as in CLAUDE.md §7.6 (lane file with Agent: Cowork and Status: review, changes left uncommitted).
```
