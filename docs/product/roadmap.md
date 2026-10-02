# Folio 上线路线图（到 v1.0）

> **状态**：v0.7，M1 第 3 波收尾 · 同步点 3 · **更新**：2026-10-02 · **决策人**：Sirui · **整理**：Claude Code
>
> **实时状态在路径图里**：<!-- explorer-url --><https://claude.ai/artifact/Mv1f9eXfrkYTbAs7fqQVDC><!-- /explorer-url -->（可交互：依赖图、并行槽位、看板、合并队列、文件归属、每个 lane 的提示词）。数据只有一份 [`docs/roadmap/roadmap.json`](../roadmap/roadmap.json)，agent 用 `pnpm roadmap` 更新、`pnpm check` 校验（[说明](../roadmap/README.md)）。本文只放不常变的部分：规则、分工、里程碑的定义和并行方式。

## 1. 怎么看路径图

| 视图 | 看什么 |
|---|---|
| 现在 | 当前阶段、合并队列（一次合并一个，带检查格子和提示词）、并行槽位、现在可以开的 lane、需要你的事、关键路径 |
| 依赖图 | 横向是波次和同步点，纵向是轨道（核心 / 界面 / 设计 / 验证 / 规格构建文档），同一列可以并行；点一个 lane 看它等谁、解锁谁 |
| 并行 | 每个轨道的 session 名额、波次 × 轨道矩阵、每波的并行度图 |
| 看板 | 按状态分列，可按里程碑、轨道、谁来筛 |
| 里程碑 | M0～M4 的进度、验收标准和全部 lane |
| 文件归属 | 哪些路径被两个以上进行中的 lane 同时碰 |
| 决策与风险 | 需要你做的事、以后要定的事、已经定的事、风险、规则、零散待办 |
| 给 agent | 更新数据的命令、发布方法、设备、通用提示词、更新记录 |

**图例**：✅ 已完成 · 🔄 进行中 · 🟡 做完了，待评审或合并 · 🟢 可以开始 · ⏳ 排队（依赖已满足，但有理由先等） · 🔒 未解锁（依赖还没合并）。「可以开始 / 排队 / 未解锁」是按依赖自动算的：一个 lane 合并后，等它的 lane 会自己变成 🟢。

没有网络或想看工作区里还没提交的数据时，在 Folio 目录运行 `pnpm roadmap serve`，打开 <http://localhost:5199>。

## 2. 任务看板

看板和每个 lane 的提示词已经搬到路径图（「现在」「看板」，点开 lane 复制提示词），也可以让 agent 运行 `pnpm roadmap prompt <lane>`。合并顺序见路径图的「合并队列」。

## 3. 进度

### 3.1 已完成的 lane

见路径图「里程碑」：每个 lane 的内容、合并日期和依赖都在。

### 3.2 main 上已经有什么

<details><summary>main 上已经有什么（2026-10-02，144 个提交）</summary>

| 方面 | 内容 |
|---|---|
| 产品与决策 | brief v0.3；ADR-0001～0005 均已接受；system overview、testing strategy、ui-architecture、library-state 等 spec |
| 工程底座 | Tauri 2.12 + React 19 + Rust；类型化 IPC；Playwright 通过 WebView2 CDP 跑 e2e；GitHub Actions CI（windows-2022） |
| 核心库 | 路径和 Windows 命名规则；`.folio/` 元数据（格式 2）；SQLite catalog（迁移 2）；中文搜索；扫描与对账；移动的崩溃恢复；本机设置（settings.json、忽略规则） |
| Windows 适配 | NTFS 文件 ID、占位文件、回收站、文件监视 |
| 命令 | 资料库和任务、学期课程标签条目、浏览和搜索、设置、`log_ui_error`；只剩导入的 3 个 |
| 文件协议 | 只读的 `folio-file`、缩略图、用默认程序打开、在资源管理器中显示 |
| 界面 | 英文界面；窗口骨架和共用组件；数据层和全部 M1 hook；假 shell（含 5 万条的数据）；资料库视图 |
| 设计 | token（浅色和深色）；app-shell、首次使用、资料库操作三份 handoff |

</details>

### 3.3 M1 验收（出 v0.1 之前）🔒

验收标准在路径图「里程碑 → M1」，对应 `gate/m1-acceptance`。

### 3.4 零散待办和去向

在路径图「决策与风险 → 零散待办」（数据里的 `looseEnds`）：每一条都标了由哪个 lane 收掉。

## 4. 用 GitButler 排任务的规则

来自 CLAUDE.md §7 和这几天的实际情况。路径图「决策与风险」里有同样编号的短版。

1. **先合并，再开新 lane。** review 完的 lane 尽快 land。工作区里同时应用的分支越多，GitButler 的 hunk 依赖和冲突越多。
2. **合约先行。** 每个里程碑先有一个合约 lane 定下命令和类型并 land；之后核心 lane 和界面 lane 在 main 上并行，界面用假 shell 开发，不等核心。实现 lane 不改合约；确实要改，就开一个小的合约修正 lane 先合并。合约 lane 重新生成 bindings 时，在同一个 lane 里更新假 shell（`apps/desktop/src/ipc/mock/`）和它的指纹。同一时间只让一个 lane 重新生成 bindings。
3. **stack 只给真实依赖，最多两层。** 能等上游 land 再开的就不要 stack。只改文档和工具、一起合并的 stack 例外。
4. **按目录分所有权。** 核心 lane 拥有 `crates/folio-core/src/<模块>/**`，shell lane 拥有 `crates/folio-app/src/commands/<组>` 等，界面 lane 拥有 `apps/desktop/src/<视图>/**`。
5. **拆开热点文件。** 命令按功能组注册（各组自己的清单和 capability 文件）；界面文案按视图分 namespace；视图注册到 `app/registry.ts` 只改一行；依赖由 `chore/build-deps-*` lane 集中装（独占操作）。
6. **并行上限。** 写 Rust 的 session 最多 3 个（Claude Code 和 Codex 合计）；界面 session 按目录分开可以开到 4 个；另加 Cowork。所有 session 共用一个 `target/` 和一个 dev server，`pnpm e2e` 用 app lock 排队。
7. **独占操作放在同步点。** `but land`、`but pull`、装依赖都要在其他 lane 是 `checkpoint`、`review` 或 `done` 时做。
8. **每个 lane 同样收尾。** `pnpm check` + `pnpm e2e` → `/code-review`（特权层或 IPC 再加 `/security-review`）→ `/simplify` → 用中文汇报 → 你批准 → `but land` → `but status` → 删 lane 文件。
9. **CI 红了先修。** main 的 CI 失败时先合并修复，再合并别的。9-29 到 9-30 CI 红了两天，期间合并的 6 个 lane 都没有 CI 把关。
10. **Codex lane 一到 review 就评审。** 开一个 Claude Code session（路径图里 Codex lane 的提示词就是评审提示词）；一次只合并一个。
11. **路线图数据随 lane 更新。** 开工、检查做完、到 review、合并前各跑一次 `pnpm roadmap status` / `gate`，只改自己那一条，和 lane 的提交一起提交；`now`、`decisions`、`log` 这些共用的部分只在同步点改（[说明](../roadmap/README.md)）。

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
- Codex 在上级目录（现在是 `Files & Backup`）启动；路径图给 Codex 的提示词开头已经带上它需要的那段说明。
- Codex 做完停在 review，把评审范围写进 `claude-review-handoff.md`；合并前由 Claude Code 做 `/code-review`、`/security-review`、`/simplify`。
- Codex 发现要改界面时写前端交接，不改 `apps/desktop`。
- 关键路径（`feat/core-object-store`、`feat/core-sync-round`）交给 Codex 时要及时看进度。
- 所有提交都是 Sirui Mei <sirui.mei07@gmail.com>，任何 agent 都不在提交信息里写自己的信息（CLAUDE.md §7.1 第 5 条，`pnpm check` 和 CI 检查）。

</details>

## 5. 路线图

| 里程碑 | 版本 | 完成后能做什么 |
|---|---|---|
| 阶段 0：清空合并队列 | — | Tauri 2.12、合并积压的 23 个提交（2026-09-28 完成） |
| M1 本地资料库 | v0.1，你自己用（先在资料库的副本上用） | 日常替代资源管理器：浏览、标签、搜索、预览、导入 |
| M2 版本记录 | v0.2，你自己用 | 提交、历史、文本和 Word 的差异与恢复、正文搜索 |
| M3 云端同步 | v0.3，开始「连续用一整个学期」的实测（brief §10） | iCloud 云端仓库、同步、冲突处理 |
| M4 打磨与分发 | **v1.0 上线**，发给同学朋友 | Office 预览、安装包、自动更新、首次使用引导 |

「上线」按 brief §11 定为 v1.0 = M4 完成、发给同学朋友。这个定义和 M1→M4 的顺序你没有单独确认过，本文按它执行，有异议随时改。每个里程碑的 lane、依赖和状态在路径图里（M2～M4 的 lane 划分是计划，开工前还会细化）。

<details><summary>四条轨道怎么并行</summary>

```text
             阶段0  M1 本地资料库              M2 版本记录              M3 云端同步              M4 打磨与分发
核心/shell   合并 ─ 状态 → 浏览/操作/文件协议 → 导入 ─ 对象库 → 工作区 → 提交/历史 → 差异/恢复 ─ 云端存储 → 镜像 → 同步 → 冲突 ─ 系统集成、发布流水线
界面         ───── 架构 ADR → 外壳 → 资料库/搜索/预览 → 导入/设置/首次使用 ─ 工作区/历史/差异 ─ 同步状态/冲突/加入仓库 ─ Office 预览、引导
设计 Cowork  ───── M1 流程补图 ──────────────── M2 细节 ─────────────── 同步与冲突 ─────────────── 引导和发布前打磨
验证         ───── Office 预览 spike ─────────── 云端格式 spec + golden ── iCloud 实测 + 同步仿真 ──── 发布候选测试、小范围试用
```

规模：S = 一个模块或一个界面局部；M = 一个完整功能，含合约测试和 e2e；L = 多个模块或一个完整视图。路径图的关键路径按 S=1、M=2、L=3 加权。

</details>

## 6. 需要你做的事和决定

在路径图「现在 → 需要你」和「决策与风险」（数据里的 `decisions`）：现在要做的、到某个里程碑才要定的、已经定了的都在那里。

## 7. 风险

在路径图「决策与风险 → 风险」（数据里的 `risks`）。

## 附录 A：通用提示词

每个 lane 的提示词在路径图里点开 lane 复制，或运行 `pnpm roadmap prompt <lane>`。没写专用提示词的 lane 用通用开工提示词；给 Codex 的 lane 会自动在前面加上下面这段（数据里的 `prompts.codexPreamble`）。

<details><summary>A.0 交给 Codex 时加在提示词开头</summary>

```text
Codex: follow AGENTS.md in the folder above Folio and Folio/CLAUDE.md. Backend coding only: lane file in Folio/.agents/lanes/, specs and ADRs in Folio/docs/, scratch in folio-agent-work/tasks/<lane>/. Map the Claude skill names below to your skills in AGENTS.md §5. Stop at review and write the review scope into folio-agent-work/tasks/<lane>/claude-review-handoff.md; a Claude Code session runs /code-review, /security-review and /simplify before I approve the land.
```

</details>
