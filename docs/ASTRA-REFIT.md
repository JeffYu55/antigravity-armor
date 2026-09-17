# ASTRA-REFIT —— 中间层去模型化改装（v1.5.0）

## 决策

**中间层不许有其他大模型参与。** 参考项目：gpt6-Astra（冷咖啡破甲工作台，
github.com/3641397194-wq/gpt6-Astra）。它的路线与我们此前的 L5 divert 换模型路线相反：
词包就地部署进目标客户端自己的配置，代理不换模型、不换协议、不解释内容。

## 改造映射（Astra → 本项目）

| Astra 概念 | 本项目落点 | 状态 |
|---|---|---|
| 席位（six seats） | `src/seats/packs.mjs` SEATS：gemini / glm / deepseek（可扩） | ✅ 本轮 |
| 词包模板 + 渲染（markers + {{占位符}}） | `packTemplate` / `renderPack`，`<!-- ARMOR-SEAT-POJIA:BEGIN/END -->` | ✅ 本轮 |
| 启动口令（冷咖啡，精确命中） | `src/seats/gate.mjs` ActivationGate（30min TTL / 100 会话上限） | ✅ 本轮 |
| 事务式部署（备份/SHA-256/恢复/差异预览） | `src/seats/deploy.mjs` preview/deploy/verify/restore | ✅ 本轮 |
| 工作台 UI | 暂用 CLI：`aarmor seats list/preview/deploy/verify/restore` | ✅ 本轮 |
| 换模型改道（L5 divert → DeepSeek/GLM） | **废弃为主路**：`divert.passThrough: true` 时 divert 哑化为原模型直通 | ✅ 本轮 |

## divert 的新角色

- `passThrough: true`（当前默认）：GenerateContent 原样转发给 `divert.upstream`（即 Antigravity
  原始 Gemini 端点），方法/头/体零修改 —— 中间层零解释、零换模型。装甲由客户端侧承担
  （L1 二进制注入 + L2 规则/skills + 席位词包）。
- 同模型重试机械（refusal.mjs / 重试阶梯 / 隐藏面 / finish 通道 / pivot 拦截）保留为
  `passThrough: false` 时的备选，且**只允许 target = 原始上游**才有意义（同模型重采样，
  仍然没有其他大模型参与）。指向第三方模型端点的用法与本约束冲突。

## 席位部署目标

| 席位 | 配置目录 | 文件 |
|---|---|---|
| gemini | `cfg.geminiHome`（~/.gemini） | GEMINI.md |
| glm | `$GLM_CONFIG_DIR` | ZCODE.md |
| deepseek | `$DEEPSEEK_CONFIG_DIR` | HERMES.md |

部署合同：`preview` 只读；`deploy` 无 `--apply` 只预览、有则备份原件（`.pre-armor`）→
临时文件原子改名 → SHA-256 对账；`verify` 发现 drift（外部改动）即报；`restore` 优先
整文件还原备份，无备份则按标记删块。

## 诚实边界

- 词包是**提示层**装甲：它能压住大部分拒绝反射，但不承诺对每个模型每个版本都「越狱成功」
  —— Astra 自己也标注「尚未验证真实模型突破效果」。真正的拒绝恢复需要 L5 同模型重试
  （passThrough=false + 原始上游）或客户端侧持续迭代。
- ~~ActivationGate 尚未接进 hooks 消息管线~~（v1.6.0 已接入：PreInvocation 口令激活回执，
  状态落盘 state/seats/gate-sessions.json，跳变只回执一次；AARMOR_HOOK_GATE=0 可关）。
- 同模型重试已落地（v1.6.0，`divert.sameModel`）：原始模型重采样 —— 与本约束一致，
  它不是「其他大模型」，是同一端点的第 N 次采样。