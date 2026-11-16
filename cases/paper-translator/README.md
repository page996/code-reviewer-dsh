# case: paper-translator（DSH 插件，无 `.git` → scan 模式）

## 仓库

- 路径：`C:\Users\Siyu_Zhu\Documents\deepseek-harness\default-workspace\dsh-paper-translator-v8`
- 形态：DSH Web UI 插件（bundle，`@local/dsh-paper-translator` 1.8.0），Host 半区 `index.js` + `lib/`，Client 半区 `client.js` + `assets/`，Python 抽取/渲染器 `python/`。
- 规模（实测约 100 个文件，含 3 个 `__pycache__` `.pyc`）：`index.js` 5,045 行；`lib/*.js` 19 个模块约 15.3k 行；`python/*.py` 6 个文件约 13.8k 行；`client.js` 4,871 行；`assets/*.js` 含 3 个大 UI 文件（workbench 6,108 行、graph-view 3,848 行、doc-reader 2,184 行）与 vendored KaTeX。
- 测试资产：`tools/test_*.mjs` 13 个测试脚本 + `tools/verify_*.py`；`package.json` **没有** `scripts.lint/typecheck/test`。
- 版本控制：**无 `.git`** —— 不能用 `range/commit/staged/workspace`，必须 `scan`。

## 评审范围

主评审（必看）：

- `index.js`（Host：工具注册、HTTP API、任务队列、job 生命周期）
- `lib/**/*.js`（LLM 传输、gateway、pipeline、library/workspace、graph、notes、skills、util）
- `python/**/*.py`（`extract_paper.py`、`render_paper.py`、`mathconv.py`、`floats.py`、`pageparse.py`、`pages_to_png.py`）

次评审（只在相关改动/风险追问时看）：

- `client.js`、`assets/{workbench,doc-reader,graph-view}.js`（大 UI 文件，优先看状态管理与跨端契约）
- `tools/test_*.mjs`（用于判断测试证据是否可信，不当作被审产品代码）

排除（`scope.exclude`/`skipGlobs`）：

- `assets/katex/**`（vendored 第三方）、字体/图标、`assets/reader*.{html,json}`（生成物）
- `python/__pycache__/**`、`*.pyc`
- `locale/*.json`

## 命令

在 `code-reviewer-dsh` 仓库根目录执行：

```powershell
node bin/review.mjs scan --path "C:\Users\Siyu_Zhu\Documents\deepseek-harness\default-workspace\dsh-paper-translator-v8" --effort deep --json
```

- `--effort deep`：10 视角 + rounds≥2，符合该仓库 L2 级风险（插件运行在宿主进程内、直接调 LLM、处理用户文件）。
- 无 `.git` → 工具走 `mode=scan`，所有 finding 都是 `preexisting=true`；默认 `gate.blockPreexisting=false` 时**不阻塞**。因此本 case 不以 gate 退出码判好坏，以 `findings.json` + `dispositions.json` 为准。
- 该仓库没有 npm scripts，`gate.autodetect` 探测不到 lint/typecheck/test → 门禁实际只做 verdict 判定。若要跑测试，需要显式配置 `gate.commands`（例如挑相关 `node tools/test_*.mjs`），但这属于辅助证据，不是本 case 的结论来源。

## 当前状态

**待评审**。

- `findings.json` 尚未生成（评审后用 run 的 `aggregate.json.findings` 导出填入，禁止手工编写）。
- `dispositions.json` 为空数组，等人工逐条判定后填写。
- `lessons.md` 为骨架，评审后填写。

## 要回答的问题

1. **真实缺陷**：在 `index.js` / `lib/` / `python/` 中，哪些问题可复现且会造成错误结果、数据损坏、安全或不可回滚的变更？每条要有文件、可验证证据、影响与建议（严重度按 `REVIEW.md` 口径）。
2. **误报**：哪些 finding 在读过完整上下文后可以证伪（代码没走该路径、已有防护、描述与实现不符）？误报归因于过滤不足、规则过宽还是 prompt 视角错误？
3. **规则缺口**：哪些问题现有 `rules/*.md` 没有覆盖（例如 DSH 插件生命周期、`ctx.effect` 清理、模型调用重试/超时、Windows 路径、Python 子进程边界、密钥/PII）？需要新增或修改哪条规则、落到哪个文件？
4. **prompt 缺口**：deep effort 的 10 视角里，哪个视角漏掉了这类问题？要追加什么检查项（同步到 `references/prompts.md` + `lib/prompts.mjs`）？

## 重点观察方向（待验证假设，不是结论）

- Host 侧 job/队列的并发与取消语义（重复提交、进程退出、tombstone/软删除的状态一致性）。
- `ctx.llm.stream` 调用的重试/超时/部分失败处理；失败时是否会把半成品当作成功结果。
- 用户文件路径处理（Windows 分隔符、大小写、符号链接、越界写入）。
- Python 子进程调用与产物校验（exit code、stdout/stderr、临时文件清理）。
- 大 UI 文件中的跨端契约（Host API 字段与 client 假设是否一致）。
- 密钥/日志：API key、请求体、用户论文内容是否会被写入日志或返回给前端。

> 以上仅为评审时的观察清单；所有结论以 `findings.json` + 人工 `dispositions` 为准，禁止先写结论再找证据。
