---
id: lang-js-ts
title: JavaScript/TypeScript 专项陷阱
paths: ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}"]
severityHint: major
alwaysApply: false
---
# JavaScript/TypeScript 专项陷阱

目标：只报 JS/TS 语言语义导致的真实缺陷，不报代码风格。

## 必查点
1. 比较：`==` 隐式转换、对象/数组引用比较、`NaN !== NaN`、`Object.is` 与 `includes` 对 NaN 的差异。
2. 真值判断：`0`、`''`、`[]`、`{}` 的误判；`typeof null === 'object'`；可选链 `?.` 后仍对 null 解构。
3. Promise/async：漏 `await`（尤其 `return promise` 与 `return await` 的差异、`try/catch` 捕不到未 await 的 rejection）、`Promise.all` 中一个失败其余未取消、并发无上限。
4. this 与绑定：回调中的 `this` 丢失、从对象解构方法后调用、箭头函数与普通函数混用。
5. 闭包与变量捕获：循环内 `var`/异步回调捕获同一变量、`let` 与异步组合的时序预期。
6. 类型断言：`as`/`!` 掩盖实际可能为 `undefined` 的路径；`any` 使错误绕过编译；类型守卫未覆盖运行时分支。
7. 数组/对象：`sort`/`reverse` 原地修改共享数组、`slice` 与 `splice` 混淆、展开浅拷贝导致嵌套共享、`Map/Set` 与对象键相等性。
8. JSON 与数值：`JSON.parse` 抛错未处理、大整数超过 `Number.MAX_SAFE_INTEGER`、`parseInt` 缺 radix、`toFixed` 返回字符串。
9. 时间：`new Date('YYYY-MM-DD')` 按 UTC 解析、月份从 0 开始、时区偏移。
10. 模块与运行环境：ESM/CJS 互操作、顶层 `await`、`process.env` 未定义值、浏览器/Node 环境误用、事件监听未移除。

## 证据要求
- 触发代码位置（文件:行）+ 具体输入值。
- 说明运行时实际发生什么（错误值、异常、泄漏）以及期望行为。
- 若类型系统已能阻止某场景（如严格 null 检查覆盖），不得报告。

## 判定
- blocker：静默数据错误/未捕获异常导致主流程失败。
- major：特定输入下的错误或被掩盖的 null 路径。
- minor：仅在边界输入下出现且影响可观测性有限。

## 文件与路径（Node/Windows 高频真实缺陷）
- 用户可控名字写文件：未处理 Windows 保留设备名（CON/PRN/AUX/NUL/COM1…）与结尾点号/空格时，写入失败或被重定向到设备；给出触发名字与调用点。
- `path.resolve(相对路径)` 按 `process.cwd()` 解析，不等价于“相对 workspace/root”；调用方传相对路径而 cwd 不在预期根下会静默越界或读失败。
- 边界校验只用 `path.resolve`/`path.relative` 做字面比较、未做 `realpath` 时，根内指向外部的符号链接能通过；解释实际可达的越界路径（若无调用点证据则降为 needs-human）。
- `catch {}` / `except: pass` 把 ENOENT 与 EACCES/EBUSY/JSON 解析失败合并成“文件不存在”：会静默丢 checkpoint 或把损坏状态当空状态；要求区分错误类型。
- `.catch(() => [])` / `.catch(() => null)` 把 `readdir`/`stat` 的 EACCES/EMFILE/EIO 退化成“空目录/不存在”：统计、审计、限额会静默变成 0；指出被吞的错误类型与后果。

## 前端/React 与网络调用（真实高频）
- `fetch` 无超时/`AbortSignal`，配合 `Promise.allSettled` 会让单个悬挂请求永久拖住刷新；指出悬挂点与用户可见后果。
- fire-and-forget 写请求（如 PUT active-view）错误被吞、无重试/取消；轮询与 focus/storage 事件并发触发刷新但无请求序号，旧响应覆盖新状态。
- React `state updater` 内修改 ref/外部状态（StrictMode 双调用会重复副作用）；应在 updater 外同步。
- “不可达/成环”的文件夹集合仍把环成员当根并保留父子关系，渲染会重复；检查树构建时是否断环。
- 不可信 HTML 的预览 iframe 同源且无 `sandbox`（生成文档脚本可获得主页面权限）；`href` 未校验协议（`javascript:`/`data:`）可被点击触发。
