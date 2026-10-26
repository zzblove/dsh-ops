# 项目共享记忆（`memory/`）

本项目用 Markdown 存长期记忆：**Markdown 是事实源，索引是派生缓存**。所有 agent 会话读写同一个 `memory/` 目录。

## 读（接到任务的第一个动作）

1. `node memory-kit/scripts/mem.js search "<任务关键词>"` —— 本地关键词检索，不联网；默认 3 个候选，
   要更多用 `-k 5`。
2. 候选只用于筛选。引用数字、路径、结论前必须回看原文：
   `node memory-kit/scripts/mem.js show memory/<...>.md --grep "<关键词>" -C 2`。
3. 明确"无相关记忆"就是没检索到，不要硬套低分候选；改为查看 `memory/index.md` 或在 `memory/` 里 grep。
4. 代码和用户的话优先于记忆。记忆与现场冲突时以现场为准，并写一条 `correction` 更正。

## 写（形成长期结论后立即落盘）

- `fact` = 环境事实 · `decision` = 决策与理由（含被否方案）· `howto` = 真跑通的步骤 ·
  `correction` = 用 `--supersedes` 更正旧条目。
- 一个主题一个文件，一律走 CLI（写锁、去重、索引都由它维护）：

  ```console
  node memory-kit/scripts/mem.js add --type fact --title "<主题>" \
    --summary "<一句话>" --body-file body.md --scope <范围> --source "<依据>"
  ```

- 写完执行 `node memory-kit/scripts/mem.js reindex`。
- 禁止记录密钥、账号、临时调试信息，以及代码里直接可见的内容；不要把整段会话日志抄进记忆。

## 维护

- `doctor` 查元数据 / 索引漂移，`outdated --months 6` 列过期条目，`stats` 看总量。
- 同主题合并（保留演进）→ 被取代的标 `outdated` → 只删临时内容或已有完整更正替代的错误内容；
  **决策不删**。
