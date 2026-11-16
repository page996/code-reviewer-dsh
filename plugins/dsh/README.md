# @local/dsh-code-review — DSH 插件（开发 / 安装）

DSH Host 插件半边：把本仓库的确定性代码评审核心（`lib/*.mjs`）包装成 6 个工具、一个 `/review` 命令和可选的只读 HTTP 路由。功能、工具参数、配置与限制见 [docs/DETAIL.md](docs/DETAIL.md)。

## 目录

```
plugins/dsh/
  package.json        # name @local/dsh-code-review, dsh.bundle.patch
  cordis.patch.yml    # insert { id: code-review, name: '@local/dsh-code-review' }
  index.js            # 插件入口：apply(ctx, config)
  locale/{zh,en}.json # Plugin Manager 标题/描述
  icon.svg            # 36x36 原创图标（放大镜 + diff 行）
  docs/DETAIL.md      # 功能 / 工具 / 配置 / 限制
```

运行时依赖本仓库的 `lib/`（评审引擎）与 `rules/`（内置规则），因此从本 checkout 以“本地目录”方式安装，不要脱离仓库单独拷贝 `index.js`。

## 开发自检

```powershell
# Node >= 22，零 npm 依赖
node --check plugins/dsh/index.js
node --test test/plugin.test.mjs
```

单测使用临时目录、假 `ctx`、假 `llm.stream`，不访问网络；若 `lib/*` 尚在并行开发中缺失，工具会返回 `ENGINE_UNAVAILABLE`，测试会精确报告缺失的模块。

## 安装到 DSH profile

两种方式等价，任选其一（安装后对 profile 内所有会话生效，可能触发插件热更新；替换已安装包需要重启）：

1. **DSH 内（推荐）**：调用 `plugin_manager` 工具：
   - `action: "install_bundle"`，`target: "<repo 的绝对路径>/plugins/dsh"`；
   - 例如 Windows：`E:\dsh-new-1\code-reviewer-dsh\plugins\dsh`。
2. **终端 CLI**：

   ```powershell
   dsh plugin --profile <profile名> add <repo的绝对路径>/plugins/dsh
   ```

安装完成后确认 `code-review` 条目已启用；本地目录安装会链接 checkout，因此 `../../lib` 能正常解析。

## 安装后验证

1. 用 `cordis_inspect_query`（host `Tool.listTools`）确认出现 `review_scope`、`review_plan`、`review_run`、`review_gate`、`review_report`、`review_ledger`，以及 `/review` 命令。
2. 在目标仓库的新会话里按顺序调用：
   `review_scope({mode:"workspace"})` → `review_plan({runId})` → `review_run({runId})` → `review_gate({runId})` → `review_report({runId})`。
3. 或直接输入 `/review`（非 Git 目录自动 scan）。
4. 检查 `.review/runs/<runId>/` 下产物：`scope.json`、`plan.json`、`reviews.json`、`aggregate.json`、`findings.json`、`gate.json`、`report.md/json/sarif`。
5. 若 Host 有 webServer：`GET /code-review/runs` 应返回运行列表；`GET /code-review/runs/<runId>/report.json` 返回报告。

## 配置

在 Plugin Settings 中编辑该插件行的 `config`（JSON），只使用契约配置段；仓库 `.review/config.json` 仍会作为下层读取，插件配置覆盖同名字段：

```json
{
  "model": { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "max" },
  "review": { "effort": "standard" },
  "gate": { "commands": ["npm test"], "autodetect": true }
}
```

模型路由优先级：插件配置 `model.provider`/`model.model` → 会话默认模型（`agentDefaultModel.currentSelection()`）→ `deepseek-official`/`deepseek-flash`。插件不读取、不保存任何 API key。

## 已知限制

- 门禁是软门禁：只返回 `verdict`/`exitCode`/`blocking`，不拦工具调用。
- 不在 DSH 内安装 git hook；需要提交/推送门禁请用 CLI `review install-hooks`。
- 不设 token 预算上限，`review_run` 可能耗时较长；单次 `/review` 有并发互斥。
- 报告与运行数据只写目标仓库的 `.review/`，不写 profile。
