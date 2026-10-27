# 迁移方案：本地衍生版 → 上游 v0.2.0-r3

> 生成于 2026-10-09。本文是**方案与决策文档**，不含实施改动。
> 结论先行：**可以迁移，但必须分阶段；直接覆盖会丢失 13 项关键补丁。**

---

## 一、背景与事实（全部实测）

| 项 | 事实 |
|---|---|
| 本机 DSH 版本 | **0.2.0-rc.2**（实测 `DeepSeek Harness.exe` 文件版本） |
| 本地桥接基线 | 上游 **v0.1.5** + 我们累计的 13 项补丁 |
| 上游最新版 | **v0.2.0-r3**（v0.2.1 已被作者撤回） |
| 上游 0.2.0 适配目标 | **DSH 0.2.0-rc.2** —— 与本机环境**完全匹配** |
| 代码差异规模 | **119 文件、+26604 / -3460 行** |
| bridge.js | 上游 11037 行 / 本地 9800 行 |
| 上游 console.html | 216 KB（**单文件，未做可视化拆分**） |

### 1.1 上游 v0.2.0 的主要价值

1. **修复 v0.1.7 引入的队列 bug**（README 明示）：退役/重置 QQ 会话时读不出 DSH 待处理队列，
   只留一行警告。**我们本地正带着这个 bug**（基线 v0.1.5 → 继承至 v0.1.7 的该段代码）。
2. **DSH 0.2.0-rc.2 协议适配**：以一元 RPC `session/projections` 为主路径读队列。
3. **工具守卫对账**：按 0.2.0 真实工具清单新增 **15 个必须隐藏的工具名**（安全相关）。
4. **新增 9 个模块**：`snowluma-conn.js`（换号 token 自发现）、`token-ledger.js` + `model-prices.js`
   （用量账本与费用折算）、`state-acl.mjs`（state 目录 ACL 加固）、`role-card.js`（人格卡按模式取用）、
   `voice-core.js` + `send-voice-lib.js`（语音发送）、`preset-prompt.js`、`qq-model-view.js`、
   `src/core/session-router.mjs`（会话路由，含测试）。
5. **角色卡注入上限可配置**：`role.maxInjectChars`（1000~20000，带越限警告）——
   **比我们硬改成 12000 更优雅**（我们发现的"6000 截断"问题上游也意识到了）。
6. 控制台新增「令牌与花费」「DSH 模型与思考强度」章节。

### 1.2 上游**没有**、必须保留我们实现的（逐项实测）

| # | 我们的能力 | 上游 | 我们的实现规模 |
|---|---|---|---|
| 1 | 上下文超限自动换会话（`contextRollover`） | ❌ 无 | 9 处 |
| 2 | 上下文累计估算（`contextAcc` / `charsPerToken`） | ❌ 无 | 15 处 |
| 3 | 上下文溢出判定（`isContextOverflowError`） | ❌ 无 | 4 处 |
| 4 | 附件缺失自愈（`isAttachmentMissingError`） | ❌ 无 | 6 处 |
| 5 | 会话失效判定（`isSessionMissingError`） | ❌ 无 | 5 处 |
| 6 | 会话存储丢失判定（`isSessionStorageGoneError`） | ❌ 无 | 4 处 |
| 7 | 退役令牌追踪（`retiredAgentTokens`） | ❌ 无 | 4 处 |
| 8 | 重投令牌刷新（`withFreshToken`） | ❌ 无 | 8 处 |
| 9 | 畸形 JSON 数组容错（`parseJsonArrayLenient`） | ❌ 无 | 7 处 |
| 10 | 出口净化（`peelArrayShell`） | ❌ 无 | 3 处 |
| 11 | 模型锁定 + 自动跟随（`MODEL_LOCK`） | ❌ 无 | 20 处 |
| 12 | 每群独立配置（`proactiveOverrides` / `perkey` / `wakeRec`） | ❌ 无 | 24 处 |
| 13 | 黑话草稿机制 + 研究重试 + 学习会话上下文保护 | ❌ 无 | 9 处 |
| 14 | **圈子知识库**（`src/knowledge.js` 整模块） | ❌ **无此文件** | 8830 字节 |
| 15 | **可视化控制台**（`console-v2.html`）+ 新旧版切换 | ❌ 无 | 31 KB |
| 16 | 表情批量导入（`sticker-import.js`） | ❌ 无 | 6428 字节 |
| 17 | GIF 抽帧（`gif-shrink.js`） | ❌ 无 | 4696 字节 |

> 注：上游有 `每群推荐值` 3 处、`记忆重置` 1 处、`静默` 55 处，但实现与我们的不同（我们更完整）。

---

## 二、迁移原则（按 owner 要求）

> **"我们修过的 bug 就不要用新版的代码，没修的就用新版的。"**

据此确定：

| 类别 | 取值 |
|---|---|
| 上游新增能力（我们没做的） | **用上游**：SnowLuma 自发现、token 账本、state ACL、角色卡、语音、队列 bug 修复、工具守卫对账、`session-router` |
| 我们修过的 bug / 补丁 | **用我们的**：上表 1~17 全部保留 |
| 两边都有但实现不同 | **逐个比较后择优**（见 §四） |

---

## 三、迁移基线

**以上游 v0.2.0-r3 为基线，把我们的补丁移植上去。**

理由：
- 上游新版才是为 DSH 0.2.0-rc.2 适配的（本机版本），协议层更匹配
- 上游新增的 9 个模块、队列修复、工具守卫对账是"基础设施级"改动，反向移植到旧基线更困难
- 我们的补丁多数是"加法"（新增函数 + 少量调用点接入），向上移植比反向容易

---

## 四、需要人工决策的冲突点

| 冲突 | 上游做法 | 我们的做法 | 建议 |
|---|---|---|---|
| **角色卡注入上限** | `role.maxInjectChars` 可配置（1000~20000），默认 6000 | 硬编码改为 12000 | **用上游**（可配置更优），并把默认值设为 12000 |
| **控制台 UI** | 单文件 `console.html`（216 KB，含令牌花费等新章节） | `console.html`(旧) + `console-v2.html`(可视化) + 版本切换 | **保留上游 console.html** + **移植我们的 console-v2 与切换机制** |
| **每群推荐值** | 3 处（较简） | 16 处（完整） | **用我们的** |
| **静默策略** | 55 处 | 74 处（更严格） | **用我们的**（owner 铁律：报错不发 QQ） |
| **黑话注入上限** | `injectMax: 8` + 代码内 `Math.min(30,…)` | 上限提到 200，`injectMax: 200` | **用我们的**（否则群里问黑话答不上来） |
| **学习会话管理** | 无上下文保护 | 累计字符超限静默换新 | **用我们的** |

---

## 五、分阶段实施计划

### 阶段 0：准备（已完成）
- ✅ 克隆上游 v0.2.0-r3、建实验分支 `upstream-0.2.0-migration`
- ✅ 上游基线已切入分支（119 文件差异）
- ✅ 逐项差异分析（§1.2 表）
- ✅ 锚点定位（retireSession L2595 / deliverPromptNow L8396 / scheduleProactiveCheckV2 L9766 …）

### 阶段 1：独立新模块（低风险，不侵入主流程）
上游已有、我们直接采用，无需改动：
- `snowluma-conn.js`（换 QQ 账号 401 自发现）
- `state-acl.mjs`（state 目录 ACL 加固）
- `model-prices.js` + `token-ledger.js`（用量账本）
- `role-card.js` + `preset-prompt.js` + `qq-model-view.js`（人格卡 / 预设提示词）
- `voice-core.js` + `send-voice-lib.js`（语音）
- `src/core/session-router.mjs`（会话路由 + 测试）

**验证**：语法检查 + 模块单测（上游自带 `npm run test:*`）

### 阶段 2：上游的关键修复（中风险）
- v0.1.7 队列 bug 修复（`session/projections` 读队列）
- 15 个新增隐藏工具名对账
- **验证**：`npm run verify:adaptation`（上游自带）

### 阶段 3：移植我们的 13 项补丁（高风险，核心工作）
按依赖顺序，每项独立提交 + 验证：
1. 上下文体系（`contextAcc` / `charsPerToken` / `estimatedTokens` / `isContextOverflowError` / `proactiveContextRollover` + `retireSessionHook` 注入）
2. 自愈体系（`isSessionMissingError` / `isSessionStorageGoneError` / `isAttachmentMissingError` + 各调用点）
3. 令牌体系（`retiredAgentTokens` / `withFreshToken` + 4 个投递点）
4. JSON 容错（`parseJsonArrayLenient` / `peelArrayShell` + 3 个发送出口）
5. 模型锁定（`MODEL_LOCK` / `detectModelChange` / `adoptModelChange` / `ensureChatModel`）
6. 每群配置（`perkey` 接口 + `proactiveOverrides` + `wakeRec` + `proactiveOverridesFor`）
7. 黑话体系（草稿前缀 + 研究重试 + 学习会话保护 + `injectMax` 上限 200）
8. 圈子知识库（`knowledge.js` 整模块 + 注入点 + 教学通道 + 控制台接口）
9. UI 合并（`console-v2.html` + `/api/ui/version` + 服务端注入回退按钮）

### 阶段 4：数据与配置迁移
- `state/` 数据复用验证（`slang.json` / `social-v2.json` / `stickers.json` / `knowledge.json`）
- `config.json` 迁移（合并上游新增的 `role` / `pricing` 段 + 保留我们的 `contextRollover` / `knowledge` 段）
- 上游 `socialV2` 新增 `voice` 段

### 阶段 5：全量验证
- 语法检查（全部 .js/.mjs）
- 上游自带测试（45 个 npm scripts）
- 端到端实测：启动 → 收发消息 → 黑话提取/研究 → 每群配置 → 控制台新旧版切换

---

## 六、风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| `bridge.js` 手工合并引入隐性 bug | **高** | 分阶段 + 每项独立提交 + 逐项实测；不在"半迁移"状态替换运行目录 |
| 上游重构导致补丁无法直接套用（如 `session-router.mjs` 接管了会话管理） | **中高** | 每项移植前先读上游对应实现，必要时改写补丁而非照搬 |
| `knowledge.js` 与上游无对应机制，可能与其新模块冲突 | **中** | 保持独立模块，仅接入注入点（`withSlangContext` 等价位置） |
| 数据格式不兼容 | **低** | `state/` 文件名一致；迁移前**完整备份** `state/`，并保留回退路径 |
| 迁移期间机器人不可用 | **低** | **运行目录全程不动**，实验分支独立进行 |
| 上游代码质量/许可证 | **低** | 已确认上游为公开项目；本仓库保留衍生声明与署名 |

---

## 七、回退方案

1. **运行目录不动**：`<桥接安装目录>` 全程保持现状，机器人不受影响。
2. **实验分支独立**：`<工作区>\qq-bridge-release`（分支 `upstream-0.2.0-migration`）。
3. **数据备份**：迁移前备份 `state/`（黑话/记忆/知识/表情/会话映射）。
4. **随时可弃**：实验分支不合并即可；`main` 分支保持现有可用版本。
5. **上游标签可回退**：`git checkout v0.1.5` 或切回我们的 `main`。

---

## 八、工作量评估

| 阶段 | 内容 | 预估 |
|---|---|---|
| 1 | 独立新模块 | 小（直接采用，验证即可） |
| 2 | 上游关键修复 | 小 |
| 3 | 13 项补丁移植 | **大**（bridge.js 1.1 万行，需逐项定位+改写+验证） |
| 4 | 数据/配置迁移 | 中 |
| 5 | 全量验证 | 中 |

**结论**：阶段 1、2 可较快完成且风险低；**阶段 3 是主要工作量**，建议按补丁逐项提交，
每完成 2~3 项就停下来验证一次，避免一次性堆积大量未验证改动。

---

## 九、待 owner 确认

1. 是否按本方案推进（阶段 1 → 5）？
2. §四 的 6 个冲突点决策是否认可（尤其：角色卡上限用上游可配置方案、控制台保留上游+移植可视化）？
3. 迁移完成的验收标准？（建议：现有全部功能实测通过 + 上游 `verify:adaptation` 通过）
