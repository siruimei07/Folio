# iCloud 实测（ADR-0003 行动项 4）

- Lane：`test/core-icloud-field-test`，2026-10-04；Sirui 在 iPad 上配合，Windows 端由脚本操作和记录。
- 计划和步骤：[`icloud-field-test/plan.md`](icloud-field-test/plan.md)（第二版）。
- 原始日志：[`icloud-field-test/logs/`](icloud-field-test/logs/)。三轮试跑：
  - `run1/`：只有 Windows，04:19–04:48；
  - `run2/`：文件夹 `FolioTest`，04:58–05:17，被 NFD 双胞胎卡住，后来被 Sirui 在 iPad 上删掉；
  - `run3/`：文件夹 `FolioTest2`，05:17–07:03，第 1–11 步。
- 每轮的日志文件：
  - `ops.jsonl`：脚本的操作和快照；
  - `observe.jsonl`：原始目录变化记录，以及每秒一次的占位符、固定、in-sync 状态；
  - `probe-watch.jsonl`：Folio 自己的 watcher 和文件列表（`icloud_probe`）；
  - `ipad.jsonl`：Sirui 每一步的回复，记录到达的时间。
- 截图：[`icloud-field-test/screens/`](icloud-field-test/screens/)。
- 时间都是 UTC；Sirui 的 iPad 用本地时间（UTC−4）。

## 1. 环境

| 项目 | 值 |
|---|---|
| Windows | DESKTOP-N7UG6S7，Windows 11 25H2（10.0.26200.7840），NTFS |
| iCloud for Windows | 15.8.118.0（Microsoft Store，x64），满足 ADR-0003 行动项 5 |
| iCloud 云盘 | `C:\Users\Desktop\iCloudDrive`；暂存区 `%LOCALAPPDATA%\FolioFieldTest\staging`，在同一个卷上 |
| iPad | iPadOS 27.0，「文件」App |
| 脚本 | Python 3.14.7（标准库 + ctypes）；`folio-core` 的 example `icloud_probe`，跑的是 Folio 真实的 `Watcher`、`WindowsFileSystem`、`rename_no_replace`、`WindowsRecycleBin` |

## 2. 结论一览

| 问题（行动项 4） | 答案 | 对设计的影响 |
|---|---|---|
| 冲突副本怎么命名 | **改动冲突**：两边都改了 `p3.png`，原名消失。Windows 上的版本被改名为 `p3 2.png`；iPad 的版本在 Windows 上叫 `p3(1).png`，在 iPad 上叫 `p3 3.png`。**新建冲突**：Windows 的 `new.png` 被改名为 `new 2.png`，iPad 的保留原名。离线修改图片（「标记」）时没有出现冲突副本，iPad 把那一笔重新画在了 Windows 的新版本上 | 同一个副本在两台设备上名字可以不同；**Folio 自己刚写的文件可能被 iCloud 改名**。镜像路径可能整个消失 |
| 更新怎样到达，watcher 看不看得到 | 已下载的文件：**删除 + 新增**（file id 变化），新内容直接在本地。仅云端的文件：一条**修改**记录，file id 不变，仍是占位符。Folio 的 watcher 每次都看到了 | 同一路径的删除 + 新增要当作修改，不能当作“删了又建” |
| NFD 名字 | Windows 上的 NFD 文件名**永远传不上去**。**NFC 和 NFD 双胞胎会让整个 iCloud for Windows 的上传停住**（复现两次：10 分钟以上，连别的文件夹也传不上去），删掉 NFD 那个约 6 分钟后才恢复 | 镜像里绝不能出现 NFD 名字；遇到库里的 NFD 名字要先规范化，或报告给用户 |
| Windows 上不合法的名字 | iPad 允许 `? * \| " < >`、`CON`、结尾的 `.`，只拒绝 `:`。到 Windows 后这些字符被换成 `_`（`q?.txt` → `q_.txt`，`CON.txt` → `CON_.txt`，`dot.` → `dot_.txt`）。**Windows 写一次这个文件，iCloud 上的名字就变成带 `_` 的版本** | 镜像名字和云端名字可能不一样；Folio 写入这类文件会悄悄改掉 iPad 上的名字 |
| 只改大小写的重命名 | **iPad 上改大小写，文件会被删进“最近删除”**（3 次都是这样，`Upper.txt` 最后不见了）。Windows 上改大小写，iPad 能看到新名字，但“最近删除”里会多出一份旧名字的副本。iPad 不让建只差大小写的同名文件 | Folio 的大小写重命名不能直接照搬到镜像；要绕一步（先改成临时名，再改成目标名），并当作已知风险 |
| 远端删除去哪里 | 不进 Windows 回收站，而是进隐藏的 `iCloudDrive\.Trash`，和 iPad 的“最近删除”内容一致。在 iCloud 云盘里，**任何删除或覆盖**（包括 Windows 上的永久删除和改名覆盖）**都会在“最近删除”里留一份**；`.Trash` 里重名时会加后缀 | “最近删除”是镜像里通用的安全网；镜像写入要考虑它会不断堆积 |
| Windows 回收站 | 已下载的文件：正常进回收站。**仅云端的文件：`WindowsRecycleBin` 报失败（`the shell reported nothing in the Recycle Bin`，或 `0x8007017B`），但文件其实已经被删了**（只进了 iCloud 的 `.Trash`） | 产品 bug，开修复 lane（§6） |
| 固定的文件夹 | **会继承**：iPad 新建的文件、Windows 新建的文件和子文件夹都自动固定，约 1 秒内下载完（19.6 MB 和 431 MB 都很快） | `.folio/store/` 固定一次就够 |
| head 记录和大 pack 的先后 | Windows → iPad：head 6.5 秒上传完，200 MB 的 pack 194 秒；**iPad 先看到 head，约 2.5 分钟后才看到 pack**。iPad → Windows：iPad 让小文件等 431 MB 的视频传完，两者**同时**出现在 Windows 上 | 证实“head 先于 pack 到达”，pending 状态必须有 |
| 改名覆盖还是先删再移入 | `std::fs::rename`（POSIX 语义覆盖）和 `MoveFileExW` 覆盖都**可靠**：已下载和仅云端的文件都一样，3 轮内容正确，没有残留，iPad 上没有多出文件。“先回收再移入”遇到仅云端文件会因为回收站报错而停下，**旧文件没了、新文件也没写进去** | 镜像写入用一次改名覆盖；不要先回收 |

## 3. 各步观测

时间是 run3 的 UTC 时间，原话见 `ipad.jsonl`。

### 第 1 步　iCloud 不同步的名字
- iPad 只看到 `empty.txt` 和 `normal.txt`；`a.tmp`、`b.nosync`、`~$c.docx` 没有同步。
- 在 Windows 上，这三个文件约 4 秒后就被设为 pin state **excluded**：属性同时带 `PINNED|UNPINNED`，**并且马上报 in-sync**。所以 in-sync 不等于已经上传。
- 空文件可以正常同步。

### 第 2 步　特殊文件名
- **NFD 名字传不上去。**
  - 在 Windows 上建的 `nfd-café.txt`（e + U+0301）一直没有 in-sync，iPad 也看不到（Sirui 改名的是 `nfc-café.txt`）。
  - 单独一个 NFD 文件不会拖住别的上传：之后建的两个对照文件 6 秒就传完了（05:18:38）。
- **NFC/NFD 双胞胎会卡住整个上传。**
  - run2：双胞胎放在一批文件里，25 个文件卡了 18 分钟以上。
  - 第 11 步：同一个文件夹里放一对双胞胎，加上另一个文件夹里的一个对照文件，**10 分钟里一个都没传上去**。
  - 删掉 NFD 那个以后，约 6 分钟恢复（06:56:58 → 07:02:51）。
  - 另外，把 NFD 文件**移出**同步根时，iCloud 拒绝了一次（`0x8007017B`）；直接删除可以。
- **Windows 不允许的名字。**
  - iPad 只拒绝 `colon:a.txt`，提示原话：“The name "colon:a.txt" can't be used…”。
  - 其他名字到 Windows 后，非法字符都变成 `_`：`q_.txt`、`star_.txt`、`pipe_.txt`、`quote_.txt`、`lt_gt_.txt`、`CON_.txt`、`dot_.txt`。
  - Windows 上收到的是成对的重命名记录（同一个 file id）。
  - Windows 写过 `q_.txt`（改名覆盖）和 `star_.txt`（原地改）以后，**iPad 上的名字也变成了 `q_.txt`、`star_.txt`**，内容是 Windows 写的。
  - 只读不写的 `dot.`，在 iPad 上仍然是 `dot.`。
- **一个没解释的现象。** 应用 iPad 的这批改名之前，iCloud 先把 `02-names` 设为 unpinned，把里面的文件全部释放成仅云端（05:29:20），3 分钟后又全部固定并下载（05:32:20），然后才改名（05:32:27）。第 3 步的 `03-case` 也出现过一次释放空间（05:39:14）。

### 第 3 步　大小写
- **Windows 上改大小写。**
  - `lower.txt` → `LOWER.txt`、`Folder` → `folder`：Windows 上是干净的重命名，iPad 显示新名字。
  - 但 iCloud 的 `.Trash` / “最近删除”里多了旧名字的 `lower.txt` 和 `Folder`。
  - 第一次试的时候脚本有 bug，变成了“改回原名”，没有生效。已修复后重做，日志里有记录。
- **iPad 上改大小写。**
  - `Upper.txt` → `upper.txt`：Windows 上先是一个正常的重命名，约 1 秒后 `upper.txt` 被删除，进了 `.Trash`。
  - Sirui 改了 3 次，`Upper.txt` 每次都以新的 file id 回来，又被删掉。最后 `03-case` 里没有这个文件，“最近删除”里有。
- **只差大小写的同名文件。**
  - iPad 的“复制”在 iPadOS 27 上生成 `twin copy.png`（不是 `twin 2.png`）。
  - 把它改成 `Twin.png` 被拒，提示原话：“The name "Twin" with extension ".png" is already taken.”

### 第 4 步　iPad 上的修改怎样到达 Windows
- **已下载的文件**（`win-local.png`、`ipad-local.png`）：收到的是“删除 + 新增”，同名，**新的 file id**。新内容直接在本地，不是占位符。
- **仅云端的文件**（`ipad-cloud.png`）：收到一条“修改”记录，file id 不变，大小更新，仍是占位符。
- 三次修改间隔约 30 秒，每次都在几秒内到达 Windows（05:50:40、05:51:33、05:51:54），Folio 的 watcher 每次都对那个路径发起了扫描。

### 第 5 步　删除
- **iPad 上删除。** 两个文件和一个文件夹到 Windows 是“删除”记录，内容进了 `iCloudDrive\.Trash`，Windows 回收站里没有。`.Trash` 里已经有 `Folder`，所以这次的文件夹被命名为 `folder 1.55.13 AM`。
- **Windows 上删除。**
  - 用 Folio 的回收站删已下载的 `win-recycled.txt`：成功，Windows 回收站里有一份。
  - 用 `DeleteFileW` 永久删除 `win-deleted.txt`：成功。
  - **两个文件都还在 iCloud 的“最近删除”里**（截图 `screens/step5-recently-deleted.png`）。
- **仅云端的文件。** `normal.txt`、`after-nfd.txt` 用 Folio 的回收站删时报失败，但文件已经进了 `.Trash`。第一轮里 `0x8007017B` 的失败很可能也是同一类情况（当时没有记下那些文件是不是仅云端）。
- **iPad 删掉整个测试文件夹（run2）。**
  - 整个文件夹被移进了 `.Trash`，包括从没传上去的文件。
  - **被监视的根文件夹本身被移走了，两个 watcher 都一条记录没收到**（句柄跟着文件夹一起进了 `.Trash`），是靠快照才发现的。

### 第 6 步　固定的文件夹
- iPad 在 `pinned` 里复制的文件和存的 19.6 MB 视频，到 Windows 时已经是 `PINNED`，约 1 秒内下载完。
- 对照文件夹 `06-pin` 里的同一个视频，还是仅云端。
- Windows 在 `pinned` 里新建的子文件夹 `sub` 和文件，都自动继承了固定；iPad 往 `sub` 里放的副本也一样。

### 第 7 步　覆盖的三种写法
- **iPad 下载过的 txt**：`posix`（暂存区 + `std::fs::rename`）、`movefile`（`MoveFileExW` 覆盖）、`recycle`（先回收再移入），3 轮（v2–v4）在 iPad 上内容都正确，没有多出文件，Windows 上没有残留，暂存区为空。
- **被替换掉的旧版本**每次都进了“最近删除”。重名时命名为 `posix(1).txt`、`movefile(1).txt`、`recycle(1).txt`。
- **iPad 建的、在 Windows 上是仅云端的三张图**：`posix` 和 `movefile` 都不用先下载就直接替换成功了，iPad 上看到的是绿色。`recycle` 先回收那一步报失败，但文件其实已经被删了，所以按 Folio 的流程会停下来；这一项是手动补上移入那一步的。

### 第 8 步　head 记录和大 pack
- **Windows → iPad。**
  - 06:12:06 先发布 200 MB 的 pack，紧接着发布 head。
  - head 6.5 秒上传完，pack 194 秒（06:15:20）。
  - iPad 06:13:11 已经看到 head，06:15:38 才看到 pack（距 pack 上传完成约 18 秒）。
  - 在 iPad 上点 pack 会开始下载，200 MB 约 4 秒。
- **iPad → Windows。**
  - Sirui 先存 431 MB 视频，紧接着复制一个小文件。
  - 两者**同时**出现在 Windows 上（06:21:29，Sirui 回复后约 3 分钟），都已是固定状态，8 秒内下载完。

### 第 9 步　两边同时修改
- **离线修改。**
  - iPad 离线给 `p1`、`p2` 各画一笔；Windows 在 06:23:51 把它们改成蓝色（改名覆盖）。
  - iPad 06:26:25 重新联网后，最终两边都是**蓝色加上那一笔**，没有冲突副本。p2 06:26:29、p1 06:27:49 到达 Windows，都是“删除 + 新增”。
  - 红色加线的版本哪里都找不到；“最近删除”里只有最初的红色原图。
  - 这像是「标记」把那一笔重新画在了新版本上，不能当作 iCloud 的通用规则。
- **在线、一前一后。**
  - iPad 的修改 06:30:17 到达，Windows 06:31:00 用黄色覆盖。
  - 06:31:20 iCloud 判定为冲突：Windows 的黄色版本被改名为 `p3 2.png`，iPad 的红色加线版本在 Windows 上是 `p3(1).png`，在 iPad 上是 `p3 3.png`。**`p3.png` 在两边都没了。**

### 第 10 步　两边同时新建
- iPad 离线建了红色的 `new.png`；Windows 06:34:53 建了蓝色的 `new.png` 并上传。
- iPad 06:38:15 联网，Windows 06:46:21 才收到结果（约 8 分钟）：Windows 的 `new.png` 被改名为 `new 2.png`，iPad 的保留 `new.png`。两边的名字一致。

### Folio 自己的 watcher（`icloud_probe`）
- **整体正常。** run3 里 65 次扫描，4 次全量扫描，没有失败，也没有缓冲区溢出。
- **iCloud 自己的状态变化不触发记录。** 变成占位符、in-sync、释放空间、固定，用 Folio 的过滤条件都没有记录。
- **占位符认得出来。** Folio 在默认的占位符兼容模式下，也把仅云端的文件识别成 `Placeholder`（55 次）。
- **上传状态在列表里就能看到。** 目录列表返回的 reparse tag 能看出上传状态：`0x9000201a` 是未上传，`0x9000601a` 是已上传，`0x9000401a` 是仅云端。

## 4. 和 ADR-0003 的对照

| ADR-0003 的假设 | 实测 |
|---|---|
| 事实 2：冲突副本命名不统一 | 证实，还多了：同一个副本在两台设备上名字不同；本机自己的文件也会被改名 |
| 事实 3：改名覆盖可能丢原文件 | 在 15.8 上**没有复现**：3 种写法、4 轮、已下载和仅云端都正常 |
| 事实 4：固定后后台下载，不弹提示 | 证实；而且固定会继承 |
| 事实 6：NFD 名字、非法名字 | 更严重：NFD 名字从 Windows 传不上去，NFC/NFD 双胞胎会让所有上传停住；非法字符被换成 `_`，Windows 写过以后会改掉云端名字 |
| 事实 7：在 Windows 上删除会进回收站 | 只对已下载的文件成立。仅云端的文件回收站会报失败。所有删除都会进 iCloud 的“最近删除” |
| §7：删除走 shell（回收站） | 镜像里的删除应该依赖“最近删除”，不要依赖回收站 |
| §8：head 最后发布，读的一方会遇到 pending | 证实：iPad 比 pack 早约 2.5 分钟看到 head |

## 5. 给 `docs/specs-sync` 和仿真的建议

- **假云端要模拟的情况**（`test/core-sync-simulation`）：
  - 冲突副本，三种写法：`name 2.ext`、`name(1).ext`、`name 3.ext`；同一个副本在不同设备上名字可以不同；原名可以整个消失；写入方自己的文件也会被改名；
  - 大小写重命名变成删除；
  - NFD 名字永不上传，NFC/NFD 双胞胎让其他上传停住；
  - head 比 pack 早几分钟到达，或者小文件等大文件一起到达；
  - 非法字符被换成 `_`。
- **镜像写入**：用一次改名覆盖（`std::fs::rename`），不要先回收。被替换的版本会进“最近删除”，这是额外的安全网，不是 Folio 的保证。
- **镜像删除**：直接删除，靠 iCloud 的“最近删除”。如果一定要用 Windows 回收站，先确认文件是已下载的；仅云端的文件回收会报错但已经被删（§6）。
- **名字**：
  - 镜像里只有 NFC。
  - 导入时遇到带 `_` 的名字，它可能对应 iPad 上的非法字符名。Folio 不应该往这种文件写入，除非用户同意改名。
  - 大小写重命名要绕一步（先改成临时名），并在 UI 上提示风险。
- **watcher**：
  - 同一路径的“删除 + 新增”当作修改。
  - 远端根文件夹本身被删或被移走时，watcher 收不到记录，要定期检查根路径还在不在。
- **上传状态**：
  - 用 reparse tag 或 in-sync 判断“已上传”，但 excluded 的文件也报 in-sync，要先排除。
  - “等待 iCloud”的提示要考虑停住几十分钟的情况（NFD 双胞胎）。

## 6. 发现的产品 bug

**`WindowsRecycleBin` 在仅云端的文件上报失败，但文件其实已经被删了。** 已开修复 lane `fix/core-recycle-cloud-placeholder`（roadmap 里有 prompt）。
- 现象：报的错是 `RecycleFailure::Other`，内容为“the shell reported nothing in the Recycle Bin”或 `0x8007017B`；文件已经不在原处，只在 iCloud 的 `.Trash` 里。
- 影响：
  - 资料库放在 iCloud 云盘里时，Folio 会显示“删除失败”，但文件已经没了；
  - M3 镜像如果用回收站，会在中途停下，而旧文件已经被删。
- 怎样复现：`icloud_probe recycle <仅云端文件>`。

## 7. 没有解决的问题
- 为什么 NFC/NFD 双胞胎会让所有上传停住、为什么要约 6 分钟才恢复：只能观察到现象。
- iCloud 在应用远端改名之前为什么要先释放空间、再下载（第 2 步）。
- 「标记」离线修改合并到新版本上的行为，别的 App（Pages、Word）会怎样。
- Mac 上的行为没有测（只有 iPad）。

## 8. 复现

```bash
cargo build -p folio-core --example icloud_probe
py docs/research/icloud-field-test/harness/ft.py env
py docs/research/icloud-field-test/harness/ft.py init
py docs/research/icloud-field-test/harness/ft.py observe
```

步骤见 [`plan.md`](icloud-field-test/plan.md)；每个命令的说明在 `harness/ft.py` 开头，`FT_ROOT` 和 `FT_LOGS` 用来换测试文件夹和日志目录。

## 9. 留下的测试数据
- `iCloud 云盘/FolioTest2`：第 1–11 步的数据，留着备查。
- `FolioTest`、`FolioFieldTest`：已在 iCloud 的“最近删除”里，30 天后自动清掉。
- 删除它们只会进“最近删除”，等 Sirui 决定。
