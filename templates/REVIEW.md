# REVIEW.md — 本仓库评审口径

> 复制到项目根目录，按仓库实际情况删改。工具在 R1 读取（`review.contractFile` 可指向本文件）。

## 必须重点看

- `src/auth/**`、`src/billing/**`（按项目替换）
- `migrations/**`
- `.github/workflows/**`

## 可跳过（跳过也要有理由）

- `docs/**`、`*.md`（除非改的是规范/契约文档）
- `*.lock`、`dist/**`、`generated/**`、`vendor/**`

## 本仓库常见失败模式

- 时间/时区（一律 UTC 存储）
- 金额精度（禁止 float 累加）
- 权限判断（前后端都要校验）
- 后台任务/会话生命周期
- Windows 路径分隔符与大小写

## 严重度口径

- **blocker**：错误结果、数据损坏、安全漏洞、不可回滚的变更
- **major**：边界/错误处理/契约风险，必须修复或书面说明
- **minor**：可维护性问题，不阻塞
- **preexisting**：本次变更之前就存在，单独记录，不阻塞（除非 `gate.blockPreexisting=true`）

## 证据要求

- 每条 finding 必须有 `file` + `existing_code` + `evidence` + `impact`
- 无证据的猜测进 needs-human，不进 blocker
- 行号允许近似；未锚定的 finding 不进 SARIF/行内评论

## 噪音上限

- 不报风格/格式/命名（交给 linter）
- minor 建议 ≤5 条/轮
- 同一类问题合并，并列出需要一起检查的全部实例

## 门禁命令

以下命令写入 `.review/config.json` 的 `gate.commands`（唯一事实源，本地 hook 与 CI 共用）：

- lint：`npm run lint`
- typecheck：`npm run typecheck`
- test：`npm test`
- 安全扫描（如有）：`npm run audit` / `trivy fs .`

## 放行记录（只签具体 commit）

| commit SHA | 风险级别 | 签字人 | 日期 | 备注（门禁 runId / 回滚方式） |
|---|---|---|---|---|
| | | | | |
