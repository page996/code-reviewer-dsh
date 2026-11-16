## 🤖 dsh-code-reviewer 评审结果

- run：`<runId>`｜模式：`range`｜effort：`standard`｜轮次：N
- 覆盖率：reviewed X / skipped Y（原因见下）
- 门禁：✅ pass（lint / typecheck / test 全绿）｜退出码 **0**
- 成本：input / output / cache tokens、调用次数、耗时

### 阻断项（必须修复，`blockOn` = blocker/major）

| # | 位置 | 严重度 | 问题 | 证据 | 建议 |
|---|---|---|---|---|---|
| 1 | `path/file.ts:42-45` | blocker | ... | ... | ... |

### 需人工判断（needs-human）

- [ ] `path/file.ts:120`｜原因：未锚定｜需要你回答：...
- [ ] `path/other.ts:8`｜原因：视角分歧（correctness vs tests）｜需要你回答：...

### 既有问题（preexisting，不阻塞本次）

- `path/legacy.ts:77` major：...（建议单独开 issue）

### 已解决 / outdated

- [x] `path/file.ts:12` ...（本轮已修复，重跑后消失）

### 门禁

| id | 命令 | 退出码 | 耗时 | 备注 |
|---|---|---|---|---|
| lint | npm run lint | 0 | 12s | |
| typecheck | npm run typecheck | 0 | 8s | |
| test | npm test | 0 | 61s | |

### 声明

- 降级/跳过：无（或写明 scan 模式 / LLM 未执行 / hook 被跳过 / 门禁命令豁免及原因）

---
<sub>由 dsh-code-reviewer 生成；结论只依据 `gate.json` 与退出码，不依据模型自然语言。重跑：`node bin/review.mjs all --mode range --base main`</sub>
