# 门禁（Gate）：探测、失败处理、证据、退出码

`review gate` 是唯一「机器可判定」的阻断点：它不解释模型结论，只看命令退出码 + 聚合后的 blocking findings。产物固定为 `.review/runs/<runId>/gate.json`。

## 1. 命令从哪来

1. `.review/config.json` 的 `gate.commands` 非空 → 只跑配置的命令，不再探测；
2. 否则 `gate.autodetect=true` 时按顺序探测，只保留存在的、去重：
   - `package.json` 的 `scripts.lint` → `npm run lint`
   - `scripts.typecheck` → `npm run typecheck`
   - `scripts.test` → `npm test`
   - Python/pytest 项目（`pyproject.toml`、`pytest.ini`、`tox.ini`、`setup.cfg` 中带 pytest 配置）→ `pytest`
   - `Makefile`/`makefile`/`GNUmakefile` 有 `test` target → `make test`
3. 执行器：Unix `sh -c "<cmd>"`，Windows `cmd /c "<cmd>"`；单条超时 `gate.timeoutMs`（默认 900000ms），可用条目级 `timeoutMs` 覆盖，超时按失败处理。
4. 每条写入 `gate.json.checks[]`：`id/cmd/exit/durationMs/stdoutTail/required/skipped`；`required` 命令不得 `skipped`。

`gate.commands` 支持字符串或对象（`{id, cmd, required?, timeoutMs?}`）；建议显式声明，本地 hook 与 CI 共用同一份：

```json
"gate": {
  "commands": [
    { "id": "lint", "cmd": "npm run lint", "required": true },
    { "id": "typecheck", "cmd": "npm run typecheck", "required": true },
    { "id": "test", "cmd": "npm test", "required": true }
  ]
}
```

## 2. 探测自检（可直接执行）

```powershell
node -e "const s=require('./package.json').scripts||{};console.log(Object.keys(s).filter(k=>/lint|typecheck|test/.test(k)))"
Test-Path pyproject.toml
Select-String -Path Makefile -Pattern '^test:' -ErrorAction SilentlyContinue
```

探测结果必须与 `gate.json.checks` 一致；不一致说明配置写错或命令不存在。

## 3. 失败处理

- 任一 `required` 命令非 0 → verdict=`fail`、`exitCode=4`；不允许「重试几次后算通过」。
- 先看 `stdoutTail` 区分「代码错」还是「环境错」：环境错（缺依赖/缺工具）修环境；代码错修代码。
- 本机无法执行（需要数据库/服务）→ 交 CI 跑同一命令；**不许口头豁免**。确需豁免时改 `required=false` 或从 `commands` 移除，并在报告写明理由与责任人。
- 超时 → 按失败（4）；先优化命令（只跑相关测试），不要偷偷调大 timeout 掩盖问题。
- `gate.blockOn` 默认 `["blocker","major"]`；把 minor 纳入阻断会让噪音淹没信号，不建议。
- `gate.blockPreexisting=false`（默认）：pre-existing 不阻塞；置 true 用于「顺手清理」专项。

## 4. 证据采集

- 每条命令：命令原文、exit、耗时、stdout 尾部（`gate.json.stdoutTail`；完整日志由 CI artifact 保存）。
- blocking findings：`gate.json.blocking[]` 带 `fingerprint/file/startLine/severity/title`；报告与 PR 评论引用同一份。
- `report.md` 的「门禁」节必须能追溯到 `gate.json` 的 check id。
- 不要只贴截图；CI artifact 必须包含 `gate.json` 与 `report.sarif`。

## 5. 退出码语义（唯一判定）

| 码 | 含义 | CI 行为 |
|---|---|---|
| 0 | 通过（门禁全绿、无 blocking） | 绿 |
| 2 | 有 blocking findings（blocker/major 达阈值） | 红，修代码后重跑 |
| 3 | needs-human > 0（需人判断） | 红或「需人工」check，人工处理重跑 |
| 4 | 必需门禁命令失败 | 红，修命令/代码/环境 |
| 5 | 引擎/配置错误（JSON/鉴权/内部错误） | 红，修配置或凭证，禁止当通过 |
| 1 | 用法错误（参数不对） | 红，修调用方式 |

`review all` / `review scan` 把 `gate.exitCode` 作为进程退出码；CI 只看退出码与 `gate.json`，不看 PR 评论文字。

## 6. 本地 hook 与 GitHub Actions 的关系

- **同一份命令**：`.review/config.json` 的 `gate.commands` 是本地 hook 与 CI 的唯一事实源，不要两处各写一套。
- **hook 的 fast 档只跑确定性 gate**：pre-commit 只跑配置的 `gate.commands`（autodetect 关闭，防止在 commit 时跑慢命令）；pre-push 允许 `gate.commands` + autodetect。二者都不调 LLM。
- 本地 hook = 快反馈、可绕过（`REVIEW_SKIP_HOOKS=1`）；CI = 权威、不可绕过（受 branch protection 保护）。
- 本地过了不等于 CI 过（Node/依赖/OS 不同）；CI 红了先复现同一命令，不要只改 hook。
- hook 契约由 `test/hooks.contract.mjs` 与 `.github/workflows/hooks-contract.yml` 持续验证。

## 7. branch protection 建议

- 必过 check：`ci.yml` 的 `test` job（`npm test` + 确定性自审 scan→plan→gate，无 secret）与 `review.yml` 的 `review` job（确定性 gate + LLM 评审）；GitHub UI 里勾选对应的 job 名称。
- 合并前必须 up-to-date；push 后自动 dismiss 旧 approval；
- L2+ 变更要求至少 1 个人工 approval，不能只让 bot 批准；
- release 分支开启 `enforce_admins`，不允许管理员绕过；
- fork PR 的 deterministic-only 结果不得计入「已评审」，评论里显式标注。
