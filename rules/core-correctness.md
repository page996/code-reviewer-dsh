---
id: core-correctness
title: 正确性与边界条件
paths: ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts,py,pyi,go,rs,java,kt,kts,cs,c,h,cc,cpp,cxx,hpp,hh,hxx,inl,rb,php,swift,scala,sh,bash,zsh,ps1,sql,lua,ex,exs,erl,hrl,clj,cljs,hs,ml,mli,fs,fsx,vb,dart,zig,nim,jl,sol,proto,graphql,gql,tf,hcl}"]
severityHint: blocker
alwaysApply: true
---
# 正确性与边界条件

目标：找出「在真实输入下会给出错误结果/崩溃/静默错误」的缺陷，而不是风格问题。

## 必查点
1. 空值与缺失：`null/undefined/None`、空字符串、空数组、空对象、可选字段缺省时的分支是否覆盖。
2. 边界：`0`、`-1`、最大值、空集合首尾、单元素、重复元素；循环/递归是否有终止条件与深度上限。
3. 比较与类型：隐式类型转换、`==` 与 `===`、字符串与数字混用、`NaN`、精度丢失、浮点直接比较相等。
4. 下标与偏移：off-by-one、切片区间、分页 offset/limit、`start > end`、负下标。
5. 状态机与幂等：重复执行、乱序事件、重入、部分成功后重试是否会重复写入或破坏状态。
6. 返回值契约：提前 `return` 漏掉收尾（解锁、恢复状态、提交）；有条件分支返回类型不一致。
7. 时间与金额：时区/夏令时、`Date` 解析格式、月末、闰年、金额用浮点、单位换算（秒/毫秒、分/元）。
8. 编码与解析：`JSON.parse` 失败、非 UTF-8、路径分隔符、Windows 换行、URL 编码/解码往返。

## 证据要求（缺一不可）
- 具体文件与行号（新文件行号）。
- 触发输入/调用序列（最小复现）。
- 实际错误结果（异常、错误值、错误持久化），以及期望结果。
- 为什么现有保护（校验/类型/测试）挡不住它。

## 判定
- blocker：静默产生错误数据、崩溃用户主流程、资损/越权类后果。
- major：特定合法输入下错误，但有明确触发条件。
- minor：仅影响可观测的小范围行为且不易触发。
- 没有可复现路径的猜测只能作为 needs-human，不得写成确定性缺陷。
