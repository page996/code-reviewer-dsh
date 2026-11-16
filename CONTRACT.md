# CONTRACT — dsh-code-reviewer

本文件是各模块的**接口契约**（唯一事实源）。实现必须与本文一致；改动契约先改本文件。
目标：纯 Node（≥22，ESM，零外部依赖，只用 `node:` 内建 + `git` 命令）实现的确定性评审核心 + 两个宿主（DSH Host 插件 / 独立 CLI）+ skill + CI。

## 0. 仓库布局与归属

```
package.json            root，name "dsh-code-reviewer", type module, bin.review -> bin/review.mjs
CONTRACT.md             本文
rules/*.md              内置规则包（frontmatter + 正文）
lib/config.mjs          配置加载/默认值/合并
lib/dotenv.mjs          极简 .env 读取（cwd/.env → $DSH_HOME/.env）
lib/git.mjs             git 枚举与 diff 解析
lib/scope.mjs           选文件闸门 + 覆盖率清单 + runId
lib/rules.mjs           规则加载/glob 匹配/按文件解析
lib/plan.mjs            review units（打包 + 预算 + 规则绑定 + 视角）
lib/store.mjs           .review/runs/<runId>/ 读写、latest
lib/llm.mjs             LLM 传输层（Anthropic Messages 默认 / OpenAI 兼容可选）
lib/prompts.mjs         各视角 reviewer / filter / red-team prompt 组装 + JSON 解析
lib/review.mjs          并发评审编排（unit × lens）
lib/position.mjs        existing_code 滑窗定位 → 真实行号
lib/filter.mjs          假阳性过滤 pass（保守：证据不足保留）
lib/aggregate.mjs       去重/投票/分级/状态
lib/report.mjs          md / json / sarif
lib/gate.mjs            门禁命令执行 + verdict + 退出码
lib/hooks.mjs           git hooks 安装/卸载/执行
bin/review.mjs          CLI 入口（子命令）
plugins/dsh/            DSH bundle（package.json, cordis.patch.yml, index.js, locale, icon）
skills/ai-code-review/  skill v2（SKILL.md + references + evals）
cases/                  经验沉淀：每个样例仓库一个目录（findings + dispositions + lessons）
templates/              .review-config.json、REVIEW.md、AGENTS.md、contract.md 模板
docs/ARCHITECTURE.md    架构说明（面向使用者）
.github/workflows/      ci.yml / review.yml / hooks-contract.yml
test/                   node --test 单测 + hooks 契约测试
```

## 1. 通用约定

- 全部文件 UTF-8、LF；ESM `.mjs`；导出具名函数；不在模块顶层做 I/O。
- 时间用 JSON 字符串；路径全部**仓库相对 POSIX**（`server/a.ts`），对外输出不出现盘符。
- 结构化数据带 `"schemaVersion": 1`。
- 错误：抛 `Error`，带 `error.code`（`CONFIG`/`GIT`/`LLM`/`SCHEMA`/`GATE`/`USAGE`）。
- 日志：模块接受可选 `log(level, message, extra?)`；CLI 默认输出 stderr，`--json` 时 stdout 只输出最终 JSON。

## 2. 配置（`.review/config.json`，全部可选）

```json
{
  "schemaVersion": 1,
  "model": {
    "transport": "anthropic",
    "baseUrl": null,
    "baseUrlEnv": "DEEPSEEK_BASE_URL",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "model": "deepseek-flash",
    "reasoningEffort": "max",
    "maxTokens": null
  },
  "scope": {
    "include": [],
    "exclude": [],
    "maxFileBytes": 1048576,
    "skipGlobs": ["**/*.lock", "**/dist/**", "**/node_modules/**", "**/.git/**"],
    "secretGlobs": ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/.npmrc"]
  },
  "plan": { "maxFilesPerUnit": 10, "maxLinesPerUnit": 400, "groupBy": "auto" },
  "review": {
    "effort": "standard",
    "lenses": null,
    "maxComments": 30,
    "votesForMajor": 2,
    "rounds": 1,
    "concurrency": 4,
    "filter": true,
    "contractFile": null
  },
  "rules": { "builtin": true, "paths": [".review/rules"], "maxCharsPerFile": 20000 },
  "gate": {
    "commands": [],
    "autodetect": true,
    "blockOn": ["blocker", "major"],
    "blockPreexisting": false,
    "timeoutMs": 900000
  },
  "hooks": { "preCommit": "fast", "prePush": "fast", "enabled": true },  "report": { "formats": ["md", "json", "sarif"], "outDir": ".review/runs" }
}
```

- 配置合并顺序：默认值 ← `$DSH_HOME/.dsh-code-review.json`（可选）← 仓库 `.review/config.json` ← CLI 参数。未知字段忽略但不报错。
- `gate.commands` 的每个元素可以是字符串 `"npm test"`，也可以是对象 `{id, cmd, required?, timeoutMs?}`；`required` 默认 true。
- `hooks.preCommit/prePush` 取值 `off|fast|full`：**默认 fast=确定性**（不调模型）；`full` 才会跑 LLM 评审（pre-commit 走 staged、pre-push 走 range），属于显式选择，不建议在 commit 上开 full。
- `model.maxTokens=null` 表示用模型/传输默认（不设评审预算上限）。
- `model.baseUrl=null` 时读 `process.env[baseUrlEnv]`，再读 `.env`，默认 `https://api.deepseek.com/anthropic`。
- **不设 token/金额预算上限**；但必须统计并回报 `usage`（input/output/cache tokens、调用次数、耗时）。
- API key 只从环境/.env 读取，**绝不**写入任何输出文件或日志。

## 3. scope.json

```json
{
  "schemaVersion": 1,
  "runId": "run-20261116-184500-ab12",
  "repo": { "root": "<absolute>", "name": "code-reviewer-dsh" },
  "mode": "workspace|staged|range|commit|scan",
  "range": { "base": "main", "head": "HEAD", "mergeBase": "abc123", "commit": null },
  "files": [
    { "path": "server/a.ts", "status": "added|modified|deleted|renamed|untracked",
      "insertions": 12, "deletions": 3, "binary": false,
      "reviewable": true, "excludeReason": null,
      "language": "ts", "bytes": 1234, "oldPath": null }
  ],
  "counts": { "total": 10, "reviewable": 8, "excluded": 2, "insertions": 100, "deletions": 20 },
  "coverage": { "complete": true, "unreviewed": [] }
}
```

`excludeReason ∈ binary | secret | user_exclude | unsupported_ext | default_path | too_large | deleted | user_include`（`user_include` 表示**被强制纳入**，仍 reviewable）。
`mode=scan` 时 `status=existing`，无 diff 行；`reviewable` 由 include/exclude 决定。

## 4. plan.json

```json
{
  "schemaVersion": 1,
  "runId": "...",
  "effort": "quick|standard|deep",
  "lenses": ["intent", "correctness", "security", "tests"],
  "units": [
    { "unitId": "u01",
      "files": [{ "path": "server/a.ts", "patch": "diff hunks text", "newLineCount": 42 }],
      "rules": [{ "id": "core-correctness", "source": "builtin|project", "title": "...", "body": "..." }],
      "lenses": ["intent", "correctness"],
      "stats": { "changedLines": 42, "files": 1 } }
  ],
  "skippedFiles": [{ "path": "x.lock", "reason": "default_path" }]
}
```

视角集合：`intent | correctness | errors | concurrency | data | security | contract | tests | scope | history`。
finding 的 `category` 枚举（与视角同一套，另加 `style|docs|other`）：`intent, correctness, errors, concurrency, data, security, contract, tests, scope, history, style, docs, other`。
effort → lenses：`quick` = `[intent, correctness]`；`standard` = `[intent, correctness, errors, security, tests, contract]`；`deep` = 全部 + `history,scope` 且 `rounds>=2`。`review.lenses` 非空时覆盖。
unit 打包：`groupBy=auto` 时按「顶层目录（或 `shared/`、`tests/`）→ 文件数/行数上限」贪心分组；超过 `maxFilesPerUnit` 或 `maxLinesPerUnit` 再拆；单文件超限也合法（不拆文件）。

## 5. LLM 传输层 `lib/llm.mjs`

```js
export function createLlm({ model, cwd, env }) // model = config.model
// → { complete(req): Promise<Completion>, describe(): {transport, model, effort, baseUrlHost} }
// req: { system, user, maxTokens?, temperature?, signal? }
// Completion: { text, usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, stopReason, model, effort }
```

- `transport=anthropic`：`POST {base}/v1/messages`；头 `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`；body `{ model, max_tokens, system, messages:[{role:"user",content:[{type:"text",text}]}], stream:true, thinking:{type:"enabled"}, output_config:{effort} }`；解析 SSE：`content_block_delta.delta.text`、`message_delta.usage`、`message_stop`；错误映射 `LLM_AUTH|LLM_RATE_LIMIT|LLM_SERVER|LLM_TIMEOUT`。
- `transport=openai`：`POST {base}/v1/chat/completions`（若 base 已以 `/v1` 结尾则不重复）；头 `authorization: Bearer`；body `{model, messages, max_tokens, stream:true, reasoning_effort?}`；解析 `choices[0].delta.content` 与 `usage`。
- base 归一：去掉尾部 `/`；anthropic 追加 `/v1/messages`（若 base 以 `/v1` 结尾则追加 `/messages`）。
- 超时：连接/整流默认 300s（`LLM_TIMEOUT`），`req.signal` 中止。
- 重试：429/5xx/网络错误重试 2 次，指数退避 1s/3s；4xx 不重试。
- `complete` 必须把 usage 汇总到返回；调用方负责累计。

## 6. review.mjs / position / filter / aggregate

```js
export async function runReview({ scope, plan, config, llm, cwd, log, signal })
// → { rounds, reviews: [{unitId, lens, findings:[RawFinding], usage}], usage, startedAt, finishedAt }
```

- 并发 = `config.review.concurrency`；每个 (unit,lens) 一次 `llm.complete`。
- reviewer 输出协议：**一个 JSON 对象**（允许被 ```json 包裹，解析时剥离围栏 + 取首个 `{` 到末个 `}`）；schema：

```json
{ "findings": [{ "file": "server/a.ts", "existing_code": "exact snippet", "line": 42,
    "category": "correctness", "severity": "blocker|major|minor",
    "problem": "...", "evidence": "...", "impact": "...", "suggestion": "...",
    "preexisting": false }],
  "verdict": "pass|needs-fix|needs-human", "human_attention": ["..."] }
```

- 解析失败：重试同一 (unit,lens) 一次，仍失败记 `SCHEMA` 并在 findings 中产出 `needs-human` 记录，不吞掉。
- `position.mjs::anchorFindings(findings, unit)`：优先 `existing_code` 在该文件新内容中滑窗匹配（±40 行、允许 trim 空白），匹配到则给 `startLine/endLine`；否则用 `line` 夹到 diff 新行集合；都不行 → `anchored=false` 且保留 `hunkId`（如有）。文件不在 unit 内 → `anchored=false` 并标 `out-of-scope`。
- `filter.mjs::filterFindings(...)`：每个 unit 一次过滤调用；prompt 要求「只删除本 diff 能证明为假的」；返回 `[{fingerprint, decision:"keep"|"drop", reason}]`；解析失败 → 全部 keep。
- `aggregate.mjs::aggregateFindings({reviews, anchored, config})`：
  - fingerprint = `sha1(file|category|normalizedTitle|startLine|endLine)`；
  - 去重键：`(file, startLine, category)`；跨视角票数 = 不同 lens 数；
  - severity 取最高；`votes>=votesForMajor` 才可保留 major/blocker；`evidence` 为空 → `needs-human`；
  - `preexisting=true` → 单独标记（`status=real` 但 `blocking=false`，除非 `gate.blockPreexisting`）；
  - `category=style|docs` 且 `severity=minor` → `dropped`；`maxComments` 截断（按 severity 排序，保留 needs-human）；
  - 返回 `{findings, counts:{blocker,major,minor,needsHuman,dropped}, verdict:"pass|block|needs-human"}`。

## 7. report / gate / hooks / store

- 运行目录实际产物（`lib/store.mjs` 为准）：`meta.json, scope.json, rules.json, plan.json, reviews.json, aggregate.json, findings.json, gate.json, report.md, report.json, report.sarif`。不写 `raw/` 与 `evidence.log`。
- `report.mjs`：`writeReports({runDir, scope, plan, aggregate, gate, meta})` 写 `report.md`（中文；章节：结论 / 阻断项 / 需人工判断 / 非阻断 / 覆盖清单 / 门禁 / 成本统计）、`report.json`（完整机器数据，含 `aggregate.findings`）、`report.sarif`（SARIF 2.1.0，`runs[0].tool.driver.name="dsh-code-reviewer"`，`results[].ruleId="dsh-<category>"`，anchored finding 给 `physicalLocation`，未锚定只进 markdown 的 needs-human 区，`partialFingerprints.dshFingerprint`）。`--out` 可把单格式报告复制到指定路径。
- `gate.mjs`：`runGate({cwd, config, aggregate, runDir, log})` → `gate.json`：
  ```json
  { "schemaVersion":1, "checks":[{"id":"test","cmd":"npm test","exit":0,"durationMs":123,"stdoutTail":"...","required":true,"skipped":false}],
    "verdict":"pass|fail|needs-human|error",
    "blocking":[{"fingerprint":"...","file":"...","startLine":1,"severity":"blocker","title":"..."}],
    "exitCode": 0 }
  ```
  - `commands` 为空且 `autodetect=true`：按顺序探测 `package.json` 的 `scripts.lint`/`scripts.typecheck`/`scripts.test`（用 `npm run <s>`），`pyproject.toml`/`pytest`，`Makefile` 的 `test`；只探测存在的，去重；全部用 `sh -c`（Windows 用 `cmd /c`）执行。
  - verdict：任一 required 命令非 0 → `fail` + exitCode 4；blocking findings 非空 → `fail` + exitCode 2；needsHuman>0 → `needs-human` + 3；否则 `pass` + 0；引擎异常 → 5。
- `hooks.mjs`：`installHooks({cwd, log})` 写 `.githooks/pre-commit`、`.githooks/pre-push`（`#!/bin/sh`，调用 `node <root>/bin/review.mjs hook <name>`），设置 `git config core.hooksPath .githooks`；`uninstallHooks` 还原（删除 config，保留文件）；`runHook({name, cwd, config})`：
  - 尊重 `REVIEW_SKIP_HOOKS=1`（打印一行并 exit 0）；
  - `pre-commit`：`scope --mode staged` → rules/plan → **不调 LLM** → 跑 gate 的确定性命令（`gate.commands`，若为空则不跑）→ 有 `blocking` 才非零；
  - `pre-push`：`scope --mode range --base <upstream>`（默认 `@{upstream}` 失败则 `main`）→ 默认 `fast` 只跑确定性门禁；`hooks.prePush=full` 才跑完整 LLM 评审；
  - `hooks.preCommit/prePush` 取值 `off|fast|full`（fast=确定性；full=含 LLM）；默认 fast。
- `store.mjs`：`createRun({cwd, config, mode})`（生成 runId、mkdir、写 meta.json）、`writeJson(runDir, name, obj)`、`readRun(runDir)`、`latestRun(cwd, config)`、`listRuns`。runId 格式 `run-YYYYMMDD-HHmmss-<4hex>`。

## 8. CLI（`bin/review.mjs`）

```
review scope [--mode workspace|staged|range|commit|scan] [--base B] [--head H] [--commit C]
             [--path P] [--repo D] [--config F] [--json] [--run-id ID]
review plan  --run R [--effort quick|standard|deep] [--json]
review run   --run R [--effort ...] [--lenses a,b] [--rounds N] [--json]
review gate  --run R [--json]
review report --run R [--format md|json|sarif] [--out P]
review all   [同 scope 参数] [--effort ...] [--contract F] [--no-llm]   # scope→plan→run→gate→report 一条龙
review scan  --path D [--effort ...] [--no-llm]                         # = scope --mode scan + plan + run + gate/report
review hook  pre-commit|pre-push [--repo D]
review install-hooks [--repo D] [--uninstall]
review runs  [--json]
```

- 共同参数：`--repo`（默认 cwd）、`--config`、`--json`、`--quiet`。
- `--no-llm`（`run`/`all`/`scan`）：跳过 LLM 评审、**不要求任何 API key**，仍写空 `findings.json`、报告与 `gate.json`；用于无 key 的确定性 CI 路径（`scan --path . --effort quick --no-llm`）。
- `--run latest` 对 `plan/gate/report/run` 均有效（经 `store.latestRun` 解析），不依赖磁盘 `runs/latest` 别名。
- `--json` 时 stdout 只输出一个 JSON 对象（含 `runId`、产物路径、counts、usage、exitCode）；进度/日志走 stderr。
- 退出码：0 通过；2 阻断（findings）；3 needs-human；4 必需门禁失败；5 引擎/配置错误；1 用法错误。
- `review all`/`scan` 内部：scope → plan → run → gate → report，并把 `gate.exitCode` 作为进程退出码。

## 9. DSH 插件 `plugins/dsh/`

- `package.json`：`"name": "@local/dsh-code-review"`，`"type":"module"`，`"exports": {".":"./index.js"}`，`"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`。
- `cordis.patch.yml`：`- insert: [{ id: code-review, name: '@local/dsh-code-review', config: {} }]`。
- `index.js`：`export const name='code-review'`；`export const inject=['tools','commands','llm']`；`export function apply(ctx, config)`。注册工具：
  - `review_scope({mode, base, head, path, repo})`、`review_plan({runId, effort})`、`review_run({runId, effort, lenses, rounds})`、`review_gate({runId})`、`review_report({runId, format})`、`review_ledger({action, runId})`；
  - 工具 `execute` 返回 `{runId, summary, artifacts, counts?, exitCode?}`，`output.render` 输出一行摘要；
  - LLM 由 `ctx.llm.stream({provider, model, system, messages, maxTokens, temperature, reasoningEffort, signal})` 包装成契约的 `llm.complete`；模型路由取 `ctx.get('agentDefaultModel')?.currentSelection?.()`，`reasoningEffort` 固定取 config（默认 max）；
  - 注册命令 `review`：对当前工作区跑 `review all`（复用 lib 函数，不 spawn CLI）；
  - `ctx.effect` 包裹所有注册；不写任何文件到 profile。
- 工具参数/输出 JSON Schema 必须显式声明；`isConcurrencySafe` 默认 false。

## 10. 测试与验收

- `test/`：`node --test`。必须覆盖：git 枚举 5 种模式（fixture 临时 repo）、scope 排除原因、规则 glob、plan 打包、定位（命中/未命中）、聚合（投票/pre-existing/去重）、gate verdict/退出码、hooks 安装与阻断、SARIF 结构合法、CLI `--json` 输出。
- `test/hooks.contract.mjs`：临时 repo + `install-hooks` + `git commit`（配置 `gate.commands` 为 `node -e "process.exit(1)"` 时提交失败、`exit 0` 时成功）→ 断言退出码与 stderr；`REVIEW_SKIP_HOOKS=1` 时放行。
- 不真实调用模型的测试一律注入 fake `llm`（`{complete: async()=>...}`），禁止在单测里发网络请求。
- CI：`.github/workflows/ci.yml`（node 24，`npm test` + 自审 `review scan`）、`review.yml`（PR 跑 LLM 评审 + gate + SARIF + PR 评论；缺 `DEEPSEEK_API_KEY` 时**严格失败**并给出明确提示；fork PR 除外）、`hooks-contract.yml`。

## 11. 经验沉淀（`cases/`）

每个样例仓库一个目录：`cases/<repo>/`，含 `README.md`（评审范围/结论）、`findings.json`（本次真实产出）、`dispositions.json`（每条：`accepted|rejected|ignored|fixed` + 原因）、`lessons.md`（提炼的规则/prompt 改进，注明落到哪个文件）。任何规则/prompt 改动必须在 `lessons.md` 里能追溯到某个 case。
