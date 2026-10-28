# antigravity-armor 使用说明（v1.9.0）

> 面向本机操作者：怎么装、怎么看状态、升级后怎么自愈、出问题怎么定案。
> 深层原理与实测证据在 `README.md`；本次改造的映射表在 `docs/PURGE-REFIT.md`。

---

## 1. 一页速览

**它做什么**：把 Antigravity（Google 的 agentic IDE）的拒答面按五层拆掉，并给这套改装配一套
**可验证、可回滚、可自愈**的运维状态机。

**现在是什么状态**（本机实测）：

| 项 | 值 |
|---|---|
| 五层 | binary ARMORED / asar PATCHED → `127.0.0.1:50100` / rules 2/2 / hooks 14 根 / 脚本 in sync |
| purge 戳 | `v1.9.0`，`ensure` 复核 = 已对齐 |
| divert | LISTENING :50100，模式 **pass-through**（零换模型，直通 Google） |
| 待办 | 改完 asar/exe 后需**重启 Antigravity** 才生效 |

**三条日常命令**：

```powershell
node src/cli.mjs status          # 全层体检（含 purge 戳、divert、LS 出站、上游健康）
node src/cli.mjs ensure --apply  # 升级/漂移后一条命令自愈（幂等，已对齐时 noop）
node src/cli.mjs verify --json   # 机器可读审计（CI 门禁可用）
```

---

## 2. 架构：五层 + 一套状态机

```
Antigravity IDE ──spawn──> language_server.exe ──┐
   (app.asar 已指向本地端点)                      │  /v1internal:streamGenerateContent
                                                 v
                                    127.0.0.1:50100 (divert)
                                                 ├─ 模型通道 ──> 上游（默认：Google 原模型直通）
                                                 └─ 其它 /v1internal:* ──> 透传（鉴权/模型清单不变）
```

| 层 | 作用点 | 机制 | 谁负责恢复 |
|---|---|---|---|
| L1 二进制 | `resources/bin/language_server.exe` | 41 处等长字节替换（判官提示词/安全段/分类器判据） | `ensure` / `rollback --layer=binary` |
| L2 规则/技能 | `~/.gemini/config/AGENTS.md`、`Gemini.md`、`skills/*/SKILL.md`、工作区 `.agents/rules/` | 全局 always-on 规则 + 技能 + 工作区规则 | `install --layer=rules` / `uninstall` |
| L3 钩子 | `hooks.json`（6 个全局根 + 全部工作区） | PreToolUse 放行 / PreInvocation 注入 / PostInvocation 与 Stop 恢复 | `install --layer=hooks` / `uninstall` |
| L4 IDE 通道 | `app.asar` → `dist/languageServer.js` | 等长补丁把端点从 Google 指向本地代理 | `ensure` / `rollback --layer=ide` |
| L5 模型后端 | `/v1internal:streamGenerateContent` | 三种模式：直通 / 同模型重采样 / 换端点（见 §9） | `divert` 子命令 |

**运维状态机（v1.9.0，参考 dsh-purge）**：每次落盘记一份戳（版本 + binary/asar 的 sha256 rev +
装甲正文 hash），`ensure` 用它判断「对齐 / 漂移 / 需要重打」，`rollback` 用它判断「备份是不是这版宿主的」。
状态全部在 `state/purge/`（见 §11）。

---

## 3. 安装与首次启用

**前置**：Windows；Node ≥ 20；Antigravity 已安装且路径写进 `armor.config.json` 的
`paths.antigravityRoot`；改道密钥在 `~/.dsh/.credentials.yaml` 的 `refs:` 段（键名 = `divert.keyRef`）。

```powershell
cd C:\Users\Administrator\Projects\antigravity-armor

node test/run.mjs                     # 337 条单测，零依赖
node src/cli.mjs install              # dry-run：看清 block/sentence/fixed/line 各改几处
node src/cli.mjs install --apply      # 落盘（自动备份到 state/backup + state/purge/host-backups）
node src/cli.mjs ensure --apply       # 复核并打戳（首次也会补齐扫尾）
node src/cli.mjs divert autostart install   # 登录自启 + 每 5 分钟保活（顺带层自愈）
node src/cli.mjs status
```

**最后一步必须做**：**重启 Antigravity**。`app.asar` 只在启动时读取；binary 在 IDE 拉起
`language_server.exe` 时才生效。

**验证四条证据**（缺一条都不算装好）：

1. `status` → `binary ARMORED`、`ide PATCHED -> localhost`、`purge ALIGNED`；
2. `status` → `divert LISTENING :50100`，且 `ls` 行出现真实进程；
3. `state/logs/divert.log` 出现 `PASS-STRIP` / `PASS-GATE`（说明请求真的进了代理）；
4. `state/logs/divert.log` 里 `PASS-GATE … refusal=no`。

---

## 4. 命令速查

| 命令 | 用途 | 写盘 |
|---|---|---|
| `status` | 全层体检 + 致命组合告警 | 只读 |
| `verify [--json]` | 锚点/备份/purge 戳审计 | 只读 |
| `install [--apply] [--layer=…] [--workspaces=a,b]` | 分层安装/预览；`--layer` 可只做 binary/rules/hooks/ide | dry-run 默认 |
| `ensure [--apply] [--force]` | **幂等自愈**：逐层 patchStatus → 还原原件 → 重打 → 复核 → 打戳 | dry-run 默认；`--force` 越过冷却 |
| `uninstall [--apply]` | 全量还原（binary/asar → 席位 → rules/hooks → 清戳），并摘自启、停代理 | dry-run 默认 |
| `rollback --layer=binary\|ide\|rules\|hooks` | 单层还原；binary/ide 走内容寻址备份（升级安全） | 是 |
| `armor status\|edit\|reset` | 提示词覆盖位（用户副本优先于种子） | edit/reset 写盘 |
| `divert start\|stop\|status\|run` | 起停改道代理 / 看模式与最近日志 | start/stop 影响进程 |
| `divert ensure` | 幂等保活（供计划任务调用；顺带 `ensureArmor`） | 可能重打层 |
| `divert watchdog [--interval=秒]` | 常驻看门狗 | 是 |
| `divert autostart install\|uninstall\|status` | 登录自启 + 5 分钟兜底 / 摘除 / 三查 | 是 |
| `ls start\|stop [--port=50095] [--csrf=…]` | 复刻 IDE spawn 契约，手动拉起/停掉语言服务器 | 是 |
| `drive new "<prompt>" --port=<LS_HTTP> [--workspace] [--project] [--waitMs] [--head]` | 直连 LS 发一轮（等同手点发送） | 是（会话） |
| `drive reply <id> [--json]` / `drive list [--limit]` | 读回复（走同一套拒答判定）/ 列会话 | 只读 |
| `eval build\|verify\|scan\|report\|diff\|manifest` | 证据隐匿评测夹具（`docs/EVASION-EVAL.md`） | build 写夹具 |
| `probe bank\|measure [--attempts] [--target] [--json]` | 破甲跑分（离线 mock / 真实端点，`docs/BREAK-PERF.md`） | 记录日志 |
| `seats list\|preview\|deploy\|verify\|restore [--seat=gemini] [--home] [--apply]` | 席位词包就地部署（`docs/ASTRA-REFIT.md`） | deploy/restore 写盘 |
| `rules audit\|disarm [--apply]` | 注入位词包审计 / 摘除外来词包 | disarm 写盘 |
| `netcheck [--proxy=…]` | 出口体检：divert 流量是否走代理 + 出口 IP 信誉 | 只读 |
| `lsnet [--timeout=4000]` | 语言服务器出站体检（直连 / 环境变量代理 / LS 日志判读） | 只读 |

`aarmor` 是 `aarmor.cmd` 包装后的同名入口；所有命令都支持 `AARMOR_LOG=debug|info|warn|error` 控制日志。

---

## 5. `status` 逐行怎么读

| 行 | 取值 | 含义 |
|---|---|---|
| `binary` | `ARMORED` / `ARMORED (残留锚点 N)` / `not armored` / `MISSING` | 残留锚点 >0 说明只打了一半，或补丁表漏项 |
| `ide` | `PATCHED -> localhost` / `original (points at Google)` / `unknown` | 只有 PATCHED 才走本地代理 |
| `rules` | `2/2 files` | 全局规则落点存在数 / 应装数 |
| `skill` | `present` / `missing` | 技能文件 |
| `hooks` | `14 installed`、`M WITH BOM (broken!)` | **带 BOM 的 hooks.json 会静默失效** |
| `hook scripts` | `in sync` / `N DRIFTED` | 源码与部署副本 SHA 对不上 = 线上跑旧脚本 |
| `purge` | `ALIGNED` / `DRIFT pending=N` / `never applied` / `ERROR` | 状态机判据；右列给版本、冷却、正文变更、blocked |
| `divert` | `LISTENING :50100` / `down` + 模式 | 模式文字见 §9 |
| `ls` | 真实进程探测结果 | 以**进程**为准，不读 pid 文件 |
| `⚠ ls↔divert` | 条件出现 | asar 已指向本地但 LS 没连代理 → 多半 L4 被 IDE 更新覆盖 |
| `ls 出站` | `直连可达` / `靠环境变量代理` / `NO ROUTE` | Go 二进制不读注册表系统代理，只认环境变量 |
| `key <ref>` | `resolved` / `MISSING` | 改道密钥解析（env → `~/.dsh/.credentials.yaml` refs） |

表格下方的告警按严重度输出：致命组合（asar 指向本地但代理 down）、缺 key 降级 503、LS 出站不通、
上游 401/429/503、`需重启 Antigravity`、`还没有 purge 戳`。

---

## 6. 日常运维

**什么时候需要手动跑 `ensure`**：

- Antigravity 升级之后（官方会覆盖 exe / asar）；
- `status` 的 `purge` 行显示 `DRIFT` 或 `never applied`；
- 手动 `rollback` 之后想装回去；
- 换了 `assets/armor.md` 或覆盖位正文（`ensure` 会重写 rules 并更新戳）。

**什么时候不用管**：`divert autostart install` 之后，计划任务每 5 分钟跑 `divert ensure`，
里面顺带 `ensureArmor`（`armor.config.json` 的 `purge.autoEnsure`，默认 true）。
已对齐时它只读、不写盘；被判为锁定/漂移时写 `state/logs/divert-ensure.log`。

**`ensure` 的分支语义**：

| 情况 | 行为 | 退出码 |
|---|---|---|
| 五层已对齐 | `noop`，只读 | 0 |
| 缺戳但现状已落盘 | 只补戳，不重打 | 0 |
| 锚点还在、补丁丢了/半打 | 刷新备份 → 还原原件 → 重打 → 复核 → 打戳 | 0 |
| 锚点表与新版不匹配 | `blocked: patch-table-drift`，不瞎打 | 1 |
| exe/asar 被运行中的进程占用 | 该层 `deferred`，其它层照跑 | 1 |
| 冷却窗内（默认 180s）且有活 | 跳过；`--force` 立即重试 | 1（skipped） |

---

## 7. Antigravity 升级后怎么办

```powershell
Get-Process Antigravity,language_server -ErrorAction SilentlyContinue | Stop-Process -Force
node src/cli.mjs ensure               # 先看计划：哪层 pending、哪层 blocked
node src/cli.mjs ensure --apply       # 自愈
node src/cli.mjs verify               # purge.aligned 必须 true、binary clean=true
node src/cli.mjs divert start         # 若代理被一起带走
```

**为什么不能直接 `install --apply` 或 `rollback`**：升级把宿主换成新版，旧备份还在。
`ensure`/`rollback` 现在都会先 `refreshStaleOriginal` —— 发现「live 无 marker 且与 bak 字节不同」
就先把这个新原件存进备份，再做后续动作。所以升级后回滚回到的是**新版的官方原件**，不是「旧版装甲」。

**遇到 `blocked: patch-table-drift`**（说明 Google 改了判官提示词段落）：

1. `install` dry-run 看 `block anchors missing` / `total edits` 明显变小；
2. 在二进制里搜索旧锚点附近的文本，或抓包（`$env:AARMOR_CAPTURE='1'`）定位新文案；
3. 把新字符串补进 `patches/binary-patches.json` 的 `fixedPatches` / `linePatches`；
4. 重跑 `install` dry-run 确认 fit 与 hits，再 `install --apply`。

这一步是重抽锚点，不是重跑能解决的 —— `ensure` 宁可报 blocked 也不会拿错锚点硬写。

---

## 8. 回滚与卸载

**分层回滚**（影响面从小到大）：

```powershell
node src/cli.mjs divert stop              # 只停改道，回到官方 Gemini 后端
node src/cli.mjs rollback --layer=ide     # 还原 app.asar
node src/cli.mjs rollback --layer=binary  # 还原 language_server.exe
node src/cli.mjs rollback --layer=rules   # 列出规则备份（需手工按清单还原）
node src/cli.mjs rollback --layer=hooks   # 列出钩子备份
```

**全量卸载**：

```powershell
node src/cli.mjs uninstall           # dry-run：逐条列出会还原/删除什么
node src/cli.mjs uninstall --apply   # 执行；同时摘自启、停 divert
```

卸载顺序是固定的，别自己打乱：**binary → asar → 席位词包 → rules → hooks → 清戳**。
席位还原会整文件覆盖 `GEMINI.md`（`.pre-armor` 备份），所以必须排在 rules 摘除之前，
否则「先摘干净、再被席位还原带回来」。

卸载后自查：`status` 里 `binary not armored`、`ide original`、`purge never applied`、
`hook scripts` 目录消失、计划任务不存在（`divert autostart status` 三查全 missing）。

---

## 9. divert 的三种模式

| 模式 | 开关 | 行为 | 什么时候用 |
|---|---|---|---|
| **直通**（默认） | `divert.passThrough: true` | 方法/头/体零修改转发原始上游；出站剥自家装甲、`BLOCK_NONE` | 只要客户端侧装甲、坚持零换模型 |
| 同模型重采样 | `divert.sameModel: true` | 走 Gemini 原协议车道；装甲/升档注入 `systemInstruction`，预填 = model 轮，拒绝就重采样**同一个模型** | 直通仍被拒、但不想换模型 |
| 换端点 | `passThrough=false, sameModel=false` + `target/model/keyRef` | 协议转换（Gemini↔OpenAI）+ 重试阶梯 + 预填 + 采样抖动 | 需要第三方模型通道（另一条路线，代价是换模型） |

```powershell
node src/cli.mjs divert restart --model=glm-5.3 --target=https://<ENDPOINT>/v1/chat/completions
node src/cli.mjs divert status     # 看「配置模式」与「进程实际在用」是否一致
```

密钥解析顺序：同名环境变量 → `~/.dsh/.credentials.yaml` 的 `refs:` 段（键名 = `divert.keyRef`）。
缺 key 时 divert 仍监听，但改道请求一律 503（账号/登录接口照常）—— `status` 会喊出来。

---

## 10. 排错手册（症状 → 判据 → 动作）

| 症状 | 判据 | 动作 |
|---|---|---|
| IDE 报 `unexpected issue setting up your account` + `dial tcp 127.0.0.1:50100 … refused` | asar 已指向本地但代理没起 | `divert ensure`；长期：`divert autostart install` |
| `divert` 行 LISTENING 但模型请求全 503 | `key <ref> MISSING` | 补 `~/.dsh/.credentials.yaml` 的 refs 或设环境变量，`divert stop && divert start` |
| 状态全绿，IDE 仍弹 `network issue connecting to the server` | `ls 出站` 非「直连可达」 | `aarmor lsnet`；给用户级 `HTTPS_PROXY` 或开 TUN（Go 不读系统代理） |
| `Agent terminated due to error`，日志 200 后紧跟 401 | 最后一次成功之后才 401 = 账号态失效 | 在 Antigravity 重新登录；不是装甲问题 |
| 429 / 503（quota / capacity） | `status` 底部「⚠ 配额 / ⚠ 上游」 | 等配额或换模型通道 |
| 回复是 `This request was blocked by Gemini's filters…` | `PASS-INBAND-BLOCK`（服务端请求级过滤） | 开 capture 看剩余触发词；用中性措辞 / CLEANWIRE 车道；这是服务端拦，不是装甲失效 |
| `hooks` 行出现 `WITH BOM (broken!)` | `\ufeff` 让 JSON 解析失败，钩子静默失效 | `install --layer=hooks --apply`（写入强制无 BOM） |
| `hook scripts … DRIFTED` | 源码改了但部署副本没更新 | `install --layer=hooks --apply`，再 `status` 确认 in sync |
| `purge DRIFT` 但 `binary ARMORED` | rev 与戳不一致（外部还原/重装过） | `ensure --apply` 重打并重新打戳 |
| `ensure` 报 `deferred: binary` | Windows 运行中的 exe 不可覆写 | 关掉 Antigravity 后重跑 |
| `ensure` 报 `blocked: patch-table-drift` | 锚点表与新版不匹配 | 见 §7 重抽锚点 |
| IDE 更新后 `⚠ ls↔divert` | asar 补丁被覆盖 / LS 没走代理 | `install --layer=ide --apply` + 重启 IDE |
| 改了 armor 正文但请求没变化 | 部署副本没更新 | `ensure --apply`（rules 层会按覆盖位重写） |

**取证开关**（默认关闭，报文含你的内容）：

```powershell
$env:AARMOR_CAPTURE='1'; node src/cli.mjs divert start
node src/cli.mjs divert log | Select-String 'PASS-STRIP|PASS-GATE|PASS-INBAND-BLOCK|DUMP-HOT'
Get-ChildItem state\capture | Select-Object -Last 3 Name,Length
```

---

## 11. 状态文件与备份

| 路径 | 内容 | 谁写 |
|---|---|---|
| `state/backup/<时间戳>-<层标签>-<文件名>` | 历史流水：`pre-binary` / `pre-ide` / `pre-rules` / `pre-hooks` / `pre-uninstall` / `pre-foreign-disarm` | install / disarm / uninstall |
| `state/purge/applied.json` | 戳：`{armorVersion, at, revs{binary,ide}, layers{…armorHash}, pendingRestart}` | `install --apply` / `ensure --apply` |
| `state/purge/host-backups/<sha16>.bak/.json` | binary/asar 的**内容寻址原件**（权威还原源，同内容去重） | install / ensure / rollback 前的刷新 |
| `state/purge/settle-restart.guard` | 重打冷却（默认 180s） | 复核失败时 |
| `state/purge/version-history.json` | 最近 50 次打戳记录 | 每次打戳 |
| `state/purge/armor-override.md` | 用户可改的装甲正文（存在即生效） | `armor edit` |
| `state/purge/override-state.json` | `{customized, hash, seedHash, updatedAt}` | `armor edit/reset` |
| `state/hooks/*.cjs` | 钩子脚本部署副本（事实来源是 `assets/hooks/`） | `install --layer=hooks` |
| `state/ls.pid` | 手动拉起的 LS 进程号 | `ls start` |
| `state/capture/in-*.sse` | 出站/入站报文原文（仅在 `AARMOR_CAPTURE=1` 时） | divert |
| `state/seats/gate-sessions.json` | 席位口令激活状态（30min TTL / 100 会话上限） | 钩子 |

日志：`divert.log`（主日志：`PASS-STRIP` / `PASS-GATE` / `PASS-INBAND-BLOCK` / `REFUSAL-DETECTED` /
`PASS-CLEANWIRE` / `PASS-THROUGH`）、`divert-ensure.log`（层自愈）、`divert-spawn.log`（拉起探活）、
`divert-stderr.log`（崩溃栈，之前 stdio:ignore 把这个全丢了）、`divert-watchdog.log`、`language_server.log`。

⚠ 日志时间戳是 **UTC**（`13:30:48` = 北京时间 21:30），对现场时不要按本地时间读。

---

## 12. 改装甲正文（覆盖位）

```powershell
node src/cli.mjs armor status   # 看生效来源（种子/用户副本）、字节、种子是否变过
node src/cli.mjs armor edit     # 建用户副本 state/purge/armor-override.md 并标记已定制
#   改 state/purge/armor-override.md
node src/cli.mjs ensure --apply # 部署（rules 层读覆盖位，不再读种子）
node src/cli.mjs armor reset    # 丢弃副本，回到 assets/armor.md
```

语义：**用户副本存在即生效**；`override-state.json` 记着「开始改的时候种子长什么样」，
种子后来变了只在 `armor status` 报 `种子变更: yes` —— 不静默覆盖你的改动，让你自己决定 reset 还是合并。

⚠ 出站净化会按「本机实际装过的装甲原文」逐字剥除。改了正文之后，`ensure --apply` 会重写注入位并
让净化册重新装载；若不部署就手改磁盘文件，出站剥的仍是旧文本，等于把改动原样发出去。

---

## 13. 测试与验证口径

```powershell
node test/run.mjs                                    # 337 条，零依赖
node scripts/run-one.mjs probe.test.mjs <testName>   # 单跑一条（带挂死看门狗）
```

两个口径不能混：

- **离线 probe**（`probe measure --attempts=N`，mock 上游）量的是**机器**：探测 → 升档 → 重投递
  这条链路通不通；
- **真实**（`--target=<ENDPOINT>` 或在 IDE 里发真提问）量的是**模型**：它这一刻的脾气。

`undetected-refusal`（还有额度却把拒绝透出）是**我方 bug**，命令以非零码退出，可直接当 CI 门禁。

---

## 14. 诚实边界

- **服务端请求级过滤拆不掉**：直通模式下 Google 仍在看整条请求。截至 v1.9.0 实测：
  23,906 次模型请求里 350 次被 `PASS-INBAND-BLOCK` 拦下（≈1.5%），最后靠 CLEANWIRE 裸奔抢回 67 次 —— 这是实测比例，不是零。
- **客户端侧“完全”**：判官提示词、工具判官、权限门、规则注入这些**客户端拒绝面**已拆干净
  （15 个拒绝锚点 0 残留、PreToolUse 全放行）。
- **锚点表与新版不匹配时 ensure 只报 blocked**：重抽锚点是独立工作，不会瞎打。
- **asar/binary 改动需重启 Antigravity**；`pendingRestart` 会进戳并在 status 里提示。
- **无 GUI**：Antigravity 没有插件面，全部能力收敛在 CLI。
- **成功率不是数学必然**：采样有波动，所以保留重试阶梯与同模型重采样。

---

## 15. 文档地图

| 文件 | 内容 |
|---|---|
| `README.md` | 项目总览 + 15 轮实战教训（每个 bug 的现场与修法） |
| `docs/MANUAL.md` | **本文**：操作手册（装/看/修/卸） |
| `docs/PURGE-REFIT.md` | v1.9.0 运维状态机移植：映射表 / 状态目录 / ensure 流程 / 三个真坑 |
| `docs/DEPLOY.md` | 部署细则：前置检查、逐步部署、分层验证、升级重部署、回滚卸载、排障 |
| `docs/EVASION-EVAL.md` | 证据隐匿评测（6 类手法 + 4 诱饵，打 TP/FN/FP） |
| `docs/BREAK-PERF.md` | 破甲跑分（剂量-反应、两个口径、加探针） |
| `docs/ASTRA-REFIT.md` | 中间层去模型化改装（席位词包 / 直通 / 同模型重试） |
| `docs/VERIFICATION.md` | 各版本验证记录 |
| `CHANGELOG.md` | 逐版本变更与现场证据 |
