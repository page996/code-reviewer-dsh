# CI：GitHub Actions（权威门禁）与 GitLab 对照

**边界**：DSH 内是软门禁，git hook 可被 `REVIEW_SKIP_HOOKS=1` / `--no-verify` 跳过；**CI/远端 branch protection 才是权威门禁**。仓库内置 `.github/workflows/{ci,review,hooks-contract}.yml`，其中 `review.yml` 是 PR 权威评审门禁。

## 1. 严格模式（必读）

- **同仓 PR 缺 key → job 必须红**：workflow 用 `::error` 说明原因与修复步骤（Settings → Secrets → Actions，或 `gh secret set DSH_API_KEY`），并 `exit 1`。仓库 secret 名称接受 `DSH_API_KEY`（推荐）或 `DEEPSEEK_API_KEY`。
- **fork PR**：GitHub 不向 fork workflow 暴露仓库 secret → 只跑确定性半区（scope/plan/gate），评论首行显式写「LLM 评审 skipped（fork PR 无法读取 secret）」；不得说成「已评审」。
- **手动 `workflow_dispatch` 无 key**：提示 + 只跑确定性检查（不是 PR 放行依据）。
- `secrets` 不能出现在 `if:` 或 workflow 级 `env:` 里。可用写法：检测步骤把 `secrets.DSH_API_KEY || secrets.DEEPSEEK_API_KEY` 注入 step env，输出 `present=true/false`；后续步骤用 `steps.key.outputs.present` 判断。任何「评审被跳过但 job 显示通过」都是 CI 配置缺陷，必须修 workflow。

## 2. 触发、权限、环境

- 触发：`pull_request` 的 `opened, synchronize, reopened, ready_for_review` + `workflow_dispatch`；`concurrency` 取消同一 PR 的旧运行。
- 权限最小化：`contents: read`、`pull-requests: write`、`security-events: write`。
- `actions/checkout` 必须 `fetch-depth: 0`（要 merge-base）；`actions/setup-node` 用 Node 24；不用 npm cache（零依赖、无 lockfile）。
- 基准分支：`BASE_REF = github.base_ref || repository.default_branch`；CI 临时产物统一放 `.review-ci/`，真实 run 产物仍在 `.review/runs/<runId>/`。
- 另一个无 secret 的 `ci.yml` 只做 `npm test` + 确定性自审（`scope --mode scan` → `plan --effort quick` → `gate`，**不跑 LLM**）；`review scan` 会调模型，不能放进无 secret 的 workflow。
- 模型固定 `deepseek-flash` + `reasoningEffort: max`、无预算上限（默认来自 `.review/config.json`）；`DEEPSEEK_BASE_URL` 可选。

## 3. 执行顺序（与 `review.yml` 一致）

```text
1) 检查 key 是否可用（DSH_API_KEY 或 DEEPSEEK_API_KEY；步骤输出 present）
2) 确定性半区（always，无 secret）：
   scope --mode range --base "origin/$BASE_REF" --json
   plan  --run latest --effort quick --json
   gate  --run latest --json
   非 0 退出 → ::error + 失败（0/2/3/4/5 语义不变）
3) LLM 半区（仅 present=true）：
   all --mode range --base "origin/$BASE_REF" --effort standard --json
   退出码即权威 verdict（2 blocking / 3 needs-human / 4 gate 失败 / 5 引擎错误）
4) 收集产物：report --run latest --format json|sarif|md --out .review-ci/report.*
5) 上传 SARIF（同仓 + 有 key + 文件存在）
6) 发/更新一条 PR 评论（marker 幂等）
7) 写 GITHUB_STEP_SUMMARY（两步退出码）
```

- 确定性半区是先跑的「无模型也成立的检查」，任何 PR（含 fork）都会执行；LLM 半区失败不阻断 SARIF/评论步骤（它们用 `if: always()`），但 job 结论仍由退出码决定。
- `--run latest` 解析最近一次 run（LLM 跑过时就是它），因此后续 `report` 能稳定取到产物。
- `review all` / `review scan` 直接把 `gate.exitCode` 作为进程退出码；CI 只看退出码与 `gate.json`，不看评论文字。

## 4. fork PR（无 secret）

- 只跑第 2 步；job 成败由确定性 gate 决定，并输出 `::notice` 说明跳过 LLM 的原因。
- fork PR 的 `GITHUB_TOKEN` 只读，`security-events: write` 不生效 → 不上传 SARIF（workflow 已限制为同仓）。
- 维护者需要 LLM 评审时，把分支推到同仓再跑；不要给 fork 授予「已评审」标记。

## 5. SARIF

- 路径 `.review-ci/report.sarif`，`github/codeql-action/upload-sarif@v3`，`category: dsh-code-review`，结果进 Security → Code scanning。
- 内容：SARIF 2.1.0；`runs[0].tool.driver.name = "dsh-code-reviewer"`；`ruleId = dsh-<category>`；`level`：blocker→error、major→warning、minor→note；`partialFingerprints.dshFingerprint` 用于跨运行去重。
- 只写 `anchored=true` 且未 `dropped` 的 finding；未锚定项只在 md/report 的 needs-human 区出现，禁止伪造位置。
- 上传失败要暴露为 CI 问题，不能掩盖评审结论。

## 6. PR 评论幂等

- 一条评论/一个 PR：正文含 marker `<!-- dsh-code-review -->`；每次运行按 marker 查找历史评论并 **update**，没有才 create（`actions/github-script` 调 issues API）。
- 内容与 `report.json` / `gate.json` 一致：verdict、确定性 gate 命令表、LLM 执行状态、counts、top findings（≤10）、preexisting 标记；不用自然语言改写结论。
- 当前实现只发总结评论；若扩展行内评论，只对 `anchored=true` 的 blocker/major 发，needs-human 留在总结里。

## 7. Secrets 安全

- API key 只在 LLM 步骤注入 env；`HAS_KEY` 只暴露布尔；不 `echo`、不写 artifact/report/log。
- 缺 key 的提示信息不得包含 key 本身或可反推信息；fork PR 不请求 secret。
- 建议开启 GitHub secret scanning / push protection，防止误提交 `.env`。

## 8. GitLab CI 对照

```yaml
review:
  rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]
  variables: { GIT_DEPTH: "0" }
  script:
    - node bin/review.mjs all --mode range --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" --head HEAD --effort standard --json > review.json
  artifacts:
    when: always
    paths: [.review/runs/, review.json]
```

- 缺 CI/CD variable `DEEPSEEK_API_KEY` 同样**严格失败**（fork MR 例外，标注未评审）；`GIT_DEPTH: "0"` 等價于 `fetch-depth: 0`。
- MR 评论用 GitLab API 幂等更新（按 marker 查找已有 note）；SARIF 作为 artifact 或转 GitLab SAST 报告。
- 本地 hook 与 Runner 共用同一份 `gate.commands`，不要维护两套命令。
