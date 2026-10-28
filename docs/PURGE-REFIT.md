# PURGE-REFIT —— 运维状态机移植（v1.9.0）

## 决策

**把 dsh-purge 的「应用/回滚/自愈」状态机搬进本项目。**

参考对象：dsh-purge 1.1.81（本机 `~/.dsh/plugins/dsh-purge`，DeepSeek Harness 的清洗插件，
源码 `lib/reapply.js` / `lib/uninstall.js` / `lib/core.js` 的 host-backups 一段）。

本项目此前五层能力齐全，但**没有状态机**：判据只有「标记在不在」，于是三个坑一直敞着——

| 坑 | 现状 | dsh-purge 的解法 |
|---|---|---|
| Antigravity 升级后，人忘了跑 `install --apply` | 一直裸奔，status 只报「not armored」 | `reapplyInstalled` 在宿主启动/定时检查时自愈 |
| 升级后 `rollback` 把**旧版本** exe/asar 写回**新安装** | `listBackups` 取最新一份，不判断它属不属于这版宿主 | `refreshStaleBaksForUpgrade`：原文无 marker 且与 bak 不同 → 先刷 bak |
| 「标记在」≠「这版宿主打的是这套补丁」 | 半打/部分漂移只能靠肉眼 | `applied.json`（version+rev）+ 逐补丁 `patchStatus` 实检 |

移植范围**只有运维面**：状态戳、内容寻址备份、逐层 patchStatus、ensure 自愈、uninstall 全量还原、
提示词覆盖位。不移植 dock UI（Antigravity 没有插件面）、演练台、插件自更新通道。

## 改造映射（dsh-purge → 本项目）

| dsh-purge 机制 | 来源 | 本项目落点 | 状态 |
|---|---|---|---|
| `applied.json`{version,sha,at} / `installed-rev` | `lib/reapply.js` | `state/purge/applied.json`、`version-history.json` | ✅ |
| 逐补丁 `patchStatus` pending 实检 | `hostPatchesStillPending` | 四层 `patchStatus*()`（binary/ide/rules/hooks） | ✅ |
| `reapplyInstalled`：刷新 bak → revert → apply → 打戳 | `lib/reapply.js` | `aarmor ensure`（`src/purge/reapply.mjs`） | ✅ |
| `refreshStaleBaksForUpgrade` | `lib/core.js` | `refreshStaleOriginal`（`src/purge/hostbackups.mjs`） | ✅ |
| `settle-restart.guard` 冷却（防重打-重启死循环） | `lib/reapply.js` | `state/purge/settle-restart.guard`，默认 180s | ✅ |
| `uninstall` 全量还原 + 摘自启 | `lib/uninstall.js` | `aarmor uninstall`（`src/purge/uninstall.mjs`） | ✅ |
| `host-backups/<sha>.bak+.json` 内容寻址 | `~/.dsh/dsh-purge` | `state/purge/host-backups/` | ✅ |
| `prompt-inject.md` + `override-state.json`{customized,hash,seedHash} | `lib/identity.js` | `aarmor armor`（`src/purge/override.mjs`） | ✅ |
| CLI 动词 status/apply/revert/uninstall | `bin/dsh-purge.js` | `status` / `install --apply` / `rollback` / `ensure` / `uninstall` | ✅ |
| dock UI、演练台、自更新 | — | — | ✖ 不移植 |

## 状态目录

```
state/purge/
  applied.json                  戳：{armorVersion, at, revs{binary,ide}, layers{...armorHash}, pendingRestart}
  settle-restart.guard          重打冷却（cfg.purge.settleCooldownMs，默认 180s）
  version-history.json          最近 50 次打戳（对照宿主版本变化）
  host-backups/<sha16>.bak      binary / asar 原件（内容寻址，同内容去重）
  host-backups/<sha16>.json     元数据：{id, sha, size, at, paths[], lastSeenAt}
  armor-override.md             用户可改的装甲正文（存在即生效）
  override-state.json           {customized, hash, seedHash, updatedAt}
```

与 `state/backup/`（时间戳流水）并存：那是给人和历史看的，内容寻址备份是 binary/ide 的**权威还原源**。

## ensure 流程

```
aarmor ensure [--apply] [--force]
  1) 冷却守卫：settle-restart.guard 在 180s 内 → 跳过（--force 覆盖）
  2) 逐层 patchStatus：binary（逐趟锚点）/ ide（find+repl）/ rules（marker/正文）/ hooks（脚本 SHA+JSON）
  3) binary/ide 脏：
       refreshStaleOriginal（宿主被换过 → 刷 bak）
       → restoreOriginal（先回原件，杜绝半打状态叠加）
       → install{apply:true}（equal-length 重打）
       → 文件被占用（EBUSY/EPERM）→ deferred，退出码 1，提示关掉 Antigravity 重跑
  4) rules/hooks 脏：幂等安装（rules 会读覆盖位）
  5) 复核 settled → markPatchesApplied 打戳 / 否则 markSettleRestart 记冷却
```

自愈挂接：`divert autostart` 的计划任务每 5 分钟跑 `divert ensure`，其中顺带 `ensureArmor`
（`cfg.purge.autoEnsure`，默认 true）。已对齐时只读，不产生写入。

## 三个移植时修掉的真坑

1. **升级后回滚 = 版本倒退**。`rollbackBinary/rollbackIde` 现在先 `refreshStaleOriginal`：
   live 无 marker 且与 bak 不同 → 认定宿主被换过 → 先把新原件存进备份，再还原。
   实测语义：升级后回滚是「回到新版的官方原件」，不再是「把旧版写回新安装」。
2. **首次安装后永远差一口气**。`aligned` 需要戳，但戳又只在 aligned 后写 —— 死锁。
   解法：`settled`（与戳无关的「现状已落盘」）负责复核，`aligned = stampOk && settled`；
   缺戳时 ensure 只补戳不重打（对应 dsh-purge `healEmptyAppliedStamp`）。
3. **Windows 运行中的 exe 不可覆写**。ensure 捕获 `EBUSY/EPERM/EACCES/ETXTBSY` →
   该层 `deferred`、其它层照跑、退出码 1；不会把半个文件写坏。

## 诚实边界

- **锚点表与新版不匹配时只报 blocked，不瞎打**：`patch-table-drift` 意味着 Antigravity 改了
  `language_server.exe` 里的判官提示词段落，需要重抽 `patches/binary-patches.json` —— 这是独立工作，
  ensure 不会用错锚点硬写。
- **binary/asar 改动需重启 Antigravity**（asar 只在启动时读）。戳里记 `pendingRestart`，status 会喊出来。
- **冷却窗 180s**：同一次升级引发的重打不会被 5 分钟一次的计划任务反复触发；`--force` 可立即重试。
- **无 UI**：Antigravity 没有插件面，全部能力收敛在 CLI；这是刻意的（本项目一贯是 CLI + 可回归测试）。
- **rules 正文更新会整文件重写**：全局规则文件（AGENTS.md 等）由本项目全权拥有；用户若要长期自定义，
  用 `aarmor armor edit` 走覆盖位，而不是手改部署文件。
