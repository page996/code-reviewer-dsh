---
id: core-concurrency
title: 并发、异步与竞态
paths: ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts,py,pyi,go,rs,java,kt,kts,cs,c,h,cc,cpp,cxx,hpp,rb,php,swift,scala,lua,ex,exs,erl,hrl,clj,cljs,hs,ml,mli,fs,fsx,vb,dart,zig,nim,jl}"]
severityHint: blocker
alwaysApply: false
---
# 并发、异步与竞态

目标：找出「顺序执行正确、并发执行出错」的代码。

## 必查点
1. 共享可变状态：模块级/实例级变量、缓存、计数器在并发请求或 worker 间被无锁修改。
2. check-then-act：先查后写（存在性检查、余额检查、唯一性检查）缺少原子操作或事务；并发下产生重复/超卖。
3. 异步未等待：漏 `await`、fire-and-forget Promise、`forEach(async ...)`、未处理的 rejection；错误在后台丢失。
4. 竞态更新：读-改-写丢失更新；时间戳/版本号乐观锁缺失或比较错误。
5. 锁与顺序：多锁顺序不一致导致死锁；锁粒度覆盖不足；`tryLock` 失败后未处理；在锁内做网络/长耗时调用。
6. 幂等与去重：消息/请求重复投递是否重复执行；唯一键缺失或先写入后校验。
7. 取消与超时：请求取消后仍继续写共享状态；超时后重试与旧请求交错。
8. 事件循环与资源：CPU 密集任务阻塞事件循环；线程池/连接池/队列无背压（无限内存增长）。
9. 迭代安全：遍历集合时修改集合（ConcurrentModification/JS 迭代器失效）；快照与实时视图混用。

## 证据要求
- 共享状态所在位置与两个并发参与者的执行顺序（文件:行）。
- 具体交错序列或最小复现（两个请求/两个 worker）。
- 可观测后果（脏数据、重复扣减、死锁、挂起、内存增长）。
- 现有原子操作/锁/事务是否真的覆盖了该状态；未覆盖才算缺陷。

## 判定
- blocker：并发下数据损坏、重复扣款/超卖、死锁或服务不可用。
- major：存在竞态但后果有限（如缓存脏读），可自愈。
- minor：理论竞态且触发窗口极窄（需给出窗口估计）。
