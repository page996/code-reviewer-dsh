---
id: lang-python
title: Python 专项陷阱
paths: ["**/*.{py,pyi}"]
severityHint: major
alwaysApply: false
---
# Python 专项陷阱

目标：只报 Python 语言语义导致的真实缺陷，不报代码风格。

## 必查点
1. 可变默认参数：`def f(x=[])`/`{}` 在多次调用间共享；可变类属性被实例间共享。
2. 异常捕获：裸 `except:` 吞掉 `KeyboardInterrupt/SystemExit`；`except Exception` 后不处理；异常链丢失（`raise ... from`）。
3. 相等与身份：`is` 用于值比较（尤其字符串/小整数缓存导致测试偶然通过）；`==` 用于 `None` 判断虽然常见但要确认语义。
4. 闭包与延迟绑定：lambda/嵌套函数捕获循环变量，执行时已变；生成器表达式与列表推导的作用域差异。
5. 迭代器耗尽：生成器/`map`/`zip` 被消费两次、`iter()` 后 `len()`、文件句柄迭代后复用。
6. 拷贝：浅拷贝共享嵌套结构；`copy.deepcopy` 的性能与不可拷贝对象；`dict.copy()` 的隐式共享。
7. 可变性传递：函数原地修改入参（`list.sort`、`dict.update`）导致调用方状态被改；返回内部可变对象引用。
8. 异步：`asyncio` 中调用阻塞 API（`requests`、`time.sleep`、同步文件 IO）；`create_task` 未保存引用被 GC；未 `await` 的协程。
9. 资源管理：文件/连接未用 `with`；`finally` 中 return 覆盖异常；上下文管理器 `__exit__` 吞异常。
10. 时间与数值：naive `datetime` 与 aware 混用、`round` 银行家舍入、浮点金额、整数除法 `/` 与 `//` 误用。
11. 编码与路径：`open` 未指定 encoding、`os.path` 与 `pathlib` 混用、Windows 路径分隔符、`str`/`bytes` 混用。

## 证据要求
- 触发代码位置（文件:行）+ 具体输入/调用序列。
- 说明实际结果（状态污染、异常、数据错误）与期望行为。
- 如果团队已有 lint 规则覆盖该点（如 ruff 检测裸 except），仍以运行时后果为主，不要重复 lint 噪音。

## 判定
- blocker：进程崩溃/数据静默损坏/共享状态跨请求污染。
- major：特定输入或并发下错误，有明确触发路径。
- minor：理论风险且触发条件苛刻（需在 evidence 给出触发条件）。
