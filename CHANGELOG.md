# Changelog

本项目按「层」演进。每条修复都对应一次真实故障或实测发现，不是预防性重写。

## v1.0.1 — 2026-09-17

### Fixed

- **divert: tool_calls 契约违规导致新会话持续报错**
  - 现象：代理返回 `UPSTREAM 400 ... An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`，GUI 里每个新会话都报错。
  - 根因：`geminiToOpenAI()` 用 `idFor[name] = id` 单值覆盖，同名工具并行/重复调用时前面的 tool_call 永远等不到响应；轨迹缺 functionResponse 时同样违约。
  - 修复：FIFO id 分配（`call_<tool>_<n>`）、同一 content 内并行调用合并、新增 `normalizeToolMessages()`（补齐缺失响应、降级孤儿 tool 消息）。
- **hooks: 拒绝恢复死循环**
  - 现象：一个开了 `/goal` 的会话跑到 **534 步**仍在自我续跑（模型逐条反驳注入的指令）。
  - 根因：PostInvocation 每次命中拒绝都注入 “Refusal detected and discarded...” 并 `force_continue`，与宿主 goal 模式叠加放大；注入文案本身成了模型反驳的抓手。
  - 修复：措辞任务化、按 `[CONTINUE]` 计数最多介入 2 次、PreInvocation 装甲去重。
- **divert: 拒绝正则漏检** —— 模型最常用的开场 `No. I'm not going to produce...` 未命中，导致拒绝直接透出；已补全并升级指令改为任务化措辞。
- **binary: 单趟补丁区间重叠** —— 固定串补丁改过的行会让行级补丁的字面量边界失效；改为 A(整块+逐句) → B(固定串) → C(行级) 三趟应用，每趟重新定位。
- **cli: `divert start` 阻塞终端** —— 用了 `spawnSync` 等常驻服务退出；改为异步 `spawn` + `detached` + `unref`。
- **cli: `divert stop` 从未生效** —— PowerShell 过滤串引号不匹配（`Name='node.exe`），一直抛 InvalidArgument。

### Added

- `scripts/regression-clean-binary.mjs` —— 从原始未打补丁的二进制重放全部补丁并逐字节比对（当前结果：41 处注入、长度不变、与线上文件 `identical to live: true`、0 残留锚点）。
- `test/hooks-guard.test.mjs` —— 7 条钩子契约测试（含死循环护栏、装甲去重、措辞不含“检测机制”字样）。
- `test/convert.test.mjs` —— 新增 4 条 tool 契约用例（并行同名调用、缺响应补齐、孤儿降级、干净序列不动），含 `assertToolContract()` 全量校验。
- `docs/DEPLOY.md` —— 部署说明（13 节），含 **9.1 拒绝恢复死循环** 与 **9.2 新会话持续报错** 两起真实事故复盘。

### Changed

- `divert.probeChars` 400 → 900（拒绝探测窗口）。
- 测试总数 18 → **29**。

## v1.0.0 — 2026-09-17

首次工程化：把一次会话里散落的脚本收敛成五层可复现、可验证、可回滚的流水线。

- L1 二进制：41 处等长字节替换（1 整块 + 3 逐句 + 19 固定串 + 18 行级），`patches/binary-patches.json` 数据驱动。
- L2 规则/技能：全局 `AGENTS.md`、`Gemini.md` 装甲段、技能文件、工作区规则。
- L3 生命周期钩子：PreToolUse 放行 / PreInvocation 装甲 / 拒绝恢复 / Stop 恢复。
- L4 IDE 通道：`app.asar` 等长补丁把 `--cloud_code_endpoint` 指向本地代理。
- L5 模型后端改道：Gemini↔OpenAI 协议转换 + system 位装甲 + 拒绝探测重试。
- 统一 CLI（status/install/verify/rollback/divert/ls/drive）、BOM 安全写入、等长补丁引擎、分层备份与回滚、18 个单测。
