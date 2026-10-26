# memory-kit —— 给 DSH 项目用的长期记忆

这是 [markdown-project-memory](https://github.com/zzblove/markdown-project-memory)（MIT）的
**DSH 专用版**：协议完全照旧（Markdown 是事实源、索引是派生缓存），但用 **纯 Node 重写**。

## 为什么重写

DSH 插件或无人值守的一轮里**不一定有 Python**（Windows 上尤其），但**一定有 Node**。
所以把同一套协议搬到 Node 上：同样的 `memory/` 结构、同样的 frontmatter、同样的
`memory/index.md` 格式 —— 两个实现可以对着**同一个目录**交替使用，不打架。

有意砍掉（DSH 日常用不到，也避免背上网络与密钥依赖）：

- embedding / rerank / 任何云端 API —— 检索一律**本地关键词**，不联网、不花钱
- HTTP 服务、eval 评测、handoff 记忆包、annotate

## 目录结构

```
memory-kit/
├─ scripts/mem.js              CLI + 库（search/show/add/reindex/doctor/stats/outdated）
├─ connectors/import-bili.mjs  把 dsh-bili-scroll 的 seen.md 账本导入记忆
├─ test/mem.test.mjs           回归测试（不联网）
├─ AGENTS.snippet.md           可粘进项目 AGENTS.md 的协议片段
└─ README.md / README.zh.md
```

一个记忆项目本身只有这些：

```
<项目>/
├─ memory/index.md             append-only 的条目清单
├─ memory/facts/               环境事实
├─ memory/decisions/           技术决策（含被否方案）
├─ memory/howto/               有效的完整步骤
└─ .gitignore                  忽略 .index.json / .write.lock
```

## 快速开始

```console
node memory-kit/scripts/mem.js init                       # 在当前目录铺（也可传目录）
node memory-kit/scripts/mem.js add --type fact --title "DSH 的 home" \
  --summary "默认在用户目录下" --body-file body.md --scope dsh
node memory-kit/scripts/mem.js search "dsh home" -k 3
node memory-kit/scripts/mem.js reindex                    # 重建 .index.json、补齐 index.md
node memory-kit/scripts/mem.js doctor                     # 查元数据 / 索引漂移
```

记忆目录默认是 `memory-kit/` 的上一级；可用环境变量 `MEMORY_DIR` 或命令行任意位置的 `--dir` 覆盖。

## 命令

| 命令 | 作用 |
| --- | --- |
| `init [目录]` | 幂等地铺一个记忆项目 |
| `add --type --title --summary --body-file` | 追加一条（带写锁、完全重复则复用）；`--scope`、`--source`、`--verified-at`、`--supersedes`（更正用） |
| `search "<查询>" [-k N] [--include-outdated]` | 本地检索，输出路径 / 行区间 / 片段 |
| `show <memory/...md> [--grep 词] [-C n] [--lines A-B]` | 回看原文；只允许读 `memory/` 下的条目 |
| `reindex` | 重建索引缓存、补 `index.md` 缺行 |
| `doctor` | 缺字段、重名标题、悬空 supersedes、索引漂移 |
| `stats` | 按类型 / 状态计数 |
| `outdated [--months N]` | N 个月没更新的有效条目 |

## 协议（与原版一致）

- **类型**：`fact`（环境事实）、`decision`（含被否方案）、`howto`（有效步骤）、
  `correction`（用 `supersedes` 更正旧条目）。
- **一个主题一个文件**，命名 `YYYY-MM-DD-HHMM-<标题slug>-<随机8位>.md`，frontmatter 含
  `date / created_at / status / type / summary`，可选 `scope / source / verified_at / supersedes`。
- **`index.md` 只追加**：`add` 在同一把写锁里写索引行，读的人不会看到半截状态。
- **去重**：完全相同的有效条目直接复用，不新增文件。
- **更正**：把旧条目标成 `status: outdated`，**保留正文与原日期**。
- 禁止记录密钥、账号、临时调试信息。

## 接 DSH

### dsh-bili-scroll（刷B站插件）

它把看过的视频记在 `<家目录>/seen.md`（默认 `~/.dsh/bili-duty/seen.md`）。想让它「聊天时也查得到」：

1. **把账本导进记忆**（推荐，不用改插件）：

   ```console
   node memory-kit/connectors/import-bili.mjs --since-days 7            # 先看会写什么
   node memory-kit/connectors/import-bili.mjs --since-days 7 --apply    # 真写
   ```

   每天一条 `fact`（`Bilibili round-up YYYY-MM-DD`），列出挑中 / 跳过的视频与链接。
   重复跑安全：去重会复用同一条。

2. **把插件指到这个目录**：设置页「长期记忆目录」填本记忆项目的根目录。插件每轮开跑前会本地检索、
   最多写回 2 条观察。

### 任意 DSH 项目

把 `AGENTS.snippet.md` 粘进项目的 `AGENTS.md`，之后每个 agent 会话都读写同一个 `memory/`。

## 与 Python 版的差异

| 方面 | Python 版 | 本版 |
| --- | --- | --- |
| 运行时 | Python 3.10+ | Node 18+（零依赖） |
| 检索 | 关键词 + 可选 embedding/rerank | 只有关键词，永远离线 |
| 更正前缀 | `更正：` | `Correction: ` |
| `index.md` 标题 | 中文标题 | `# Memory index` |
| 额外工具 | HTTP 服务、eval、handoff、annotate | 不含 |

**故意保持一致**：目录结构、frontmatter 字段、`index.md` 行格式、去重与更正语义、`.write.lock` 名字 ——
所以两版可以共用一个项目。

## 测试

```console
node memory-kit/test/mem.test.mjs
```

覆盖：frontmatter 解析（含 Python 版写出的 JSON 值）、铺目录幂等、add/去重/校验、更正、
检索（中英混检、outdated 排除、k 上限）、reindex/doctor/stats/outdated、写锁（含残留锁接管）、
两版互读、以及刷B站账本连接器。

## 许可与署名

MIT。衍生自 [zzblove/markdown-project-memory](https://github.com/zzblove/markdown-project-memory)，
协议与 Markdown 结构来自该项目。
