---
id: core-security
title: 安全与信任边界
paths: ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts,py,pyi,go,rs,java,kt,kts,cs,c,h,cc,cpp,cxx,hpp,hh,hxx,inl,rb,php,swift,scala,sh,bash,zsh,ps1,sql,lua,ex,exs,erl,hrl,clj,cljs,hs,ml,mli,fs,fsx,vb,dart,zig,nim,jl,proto,graphql,gql,tf,hcl,yaml,yml,json,ini,conf,toml}"]
severityHint: blocker
alwaysApply: false
---
# 安全与信任边界

目标：只报告有明确攻击路径或信任边界被打破的问题；不做泛泛的安全说教。

## 必查点
1. 注入：SQL/NoSQL 拼接、命令拼接（`exec`/`spawn(shell:true)`/`os.system`）、模板注入、日志注入、正则回溯（ReDoS）。
2. 路径与文件：用户可控路径参与 `join/resolve` 后无边界校验（路径穿越）、解压覆盖（zip slip）、符号链接跟随、临时文件竞态。
3. 认证与授权：新增/修改接口是否校验身份与权限；是否只校验「已登录」而缺少资源归属校验（IDOR）；权限判断是否可被参数绕过。
4. 反序列化与代码执行：`eval`、`new Function`、`pickle`、YAML unsafe load、动态 `require/import` 用户输入。
5. 出站请求：URL 由用户控制导致 SSRF（含重定向跟随、内网地址、云元数据地址）；未校验协议与主机。
6. 密码学：自实现加密/哈希、ECB、固定 IV、明文存储口令、弱随机（`Math.random`/`random`）用于 token/密钥。
7. 密钥与凭据：硬编码密钥/token/证书； .env 或密钥进入仓库、日志、错误响应、URL query。
8. Web 边界：CORS 通配 + 凭据、CSRF 缺失、Cookie 缺 `HttpOnly/Secure/SameSite`、原型污染（`__proto__`/`constructor`）、开放重定向。
9. 依赖与配置：危险默认（`debug=true` 进生产、关闭 TLS 校验、宽泛 IAM/AWS 权限）。
10. 审批/授权依据可伪造：审批人看到的规模/影响/操作者身份来自客户端请求体（bytes、actor、role）且服务端不复核；或决定者身份未与申请者/会话校验（可自称 `system`/`user`），使“人类审批”形同虚设。

## 证据要求
- 攻击者能控制哪个输入（请求参数/文件/环境），经过哪条路径到达危险点（文件:行）。
- 具体攻击 payload 或调用序列，并说明需要的权限/前置条件。
- 后果（越权读写、命令执行、数据泄露）与现有防护为何失效。
- 若已有参数化查询、白名单、转义或权限中间件，且覆盖该路径，则不得报告。

## 判定
- blocker：可被未授权用户利用的命令执行/注入/越权/凭据泄露。
- major：需要已认证用户或特定配置的越权/信息泄露。
- minor：防御纵深缺失但当前无可达攻击路径（需在 evidence 中说明）。
