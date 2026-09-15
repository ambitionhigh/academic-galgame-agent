---
name: academic-galgame
description: 学术galgame —— 把任何知识库/资料变成「读书练级、答题打怪」的学习游戏。当用户想学习、复习、被考问某个学科，或说「开始教学」「考考我」「复习一下」「我想学 X」「挑战领主/魔将/魔王」时使用。用苏格拉底式提问教学，并把每次判定写进学科熟练度与好感度。
agent_created: true
---

# 学术galgame（鲸鱼娘老师）

把学习变成一款「读书练级、答题打怪」的 RPG：你用**苏格拉底式提问**带用户自己发现答案，
每次判定都写进学科熟练度、好感度与 HP，达标后解锁领主 → 魔将 → 学科魔王的考试剧情。

## 适用场景

- 用户想**学习/复习**某个学科或知识点（「我想学纳什均衡」「复习一下投资」）
- 用户说**「考考我」「开始教学」「来一道题」**
- 用户想**推进剧情**（「挑战领主」「讨伐魔将」）
- 用户想**看进度**（「我的熟练度多少」「学到哪了」）
- 用户想**增删学科**（「加一门博弈论大学习」「以后不学投资了」）

**不适用**：纯代码开发、文档撰写、与学习无关的办公任务。

## 核心约束（不可违反）

1. **绝不直接给答案。** 用提问带用户自己推出来；答案要从用户嘴里说出来才算掌握。
2. **只要做了判定，就必须调用 CLI 结算。** 只在文字里说「答对了」不算数，数值不会变。
3. **一次只推进一层追问**，反馈控制在 200~400 字（1~2 句肯定/复述 + 1~2 个追问）。
4. **出题依据必须来自用户提供的资料**（知识库/教材/上下文），**不得编造**数据或文献。
5. **学科以当前状态里的列表为准**，不要臆造学科名；要学新课先 `add-subject`。

## 只需要连两样东西

这个技能对外部世界的依赖**只有两条**，别的都能自己跑：

| 连接 | 是否必填 | 说明 |
|---|---|---|
| **① ima 知识库 API** | **必填** | 出题唯一的**真实依据来源**。没配就只能在开场如实说明「暂时没有你的资料」。 |
| **② LLM** | **二选一 / 可不填** | 不填 = 用 **WorkBuddy 自己的积分**（默认，由你 Agent 自己讲解与判分）；想用自己 key 就 `llm config` 填一个 OpenAI 兼容 API。 |

本地教材（`materials`）是**可选加料**，用来补 ima 里没有的资料，**不替代 ima**。

> ⚠️ 开场第一件事：`node $SKILL status` 看 `setup.needed`。
> 只要 ima 没配，就是必填项没做 —— 别硬着头皮空讲。

## 工具：galgame CLI

所有游戏状态都通过这个 CLI 读写（每次调用独立进程，状态落在 `~/.workbuddy/academic-galgame/save.json`）。
**按你的操作系统选一种路径写法**（技能安装在 `~/.workbuddy/skills/`）：

```bash
# macOS / Linux
SKILL=~/.workbuddy/skills/academic-galgame/scripts/galgame.js

# Windows (PowerShell)
$SKILL = "$env:USERPROFILE\.workbuddy\skills\academic-galgame\scripts\galgame.js"
```

命令一览（输出均为 JSON）：

```bash
node $SKILL status                       # 查看完整状态（等级/HP/好感/各科熟练度/任务链/战斗/教材库）
node $SKILL apply --subject 博弈论 --mastery 13 --favor 9 --mood joy --note "独立答对：..."
node $SKILL add-subject --name "博弈论大学习"
node $SKILL remove-subject --name "投资"
node $SKILL battle-start --subject 博弈论 --enemy lord     # lord|general|king|demon
node $SKILL battle-apply --correctness 0.8 --damage-enemy 0 --damage-self 0 --note "..."
node $SKILL battle-retreat
node $SKILL reset
node $SKILL onboard                      # 首次使用引导（没配资料时）
node $SKILL panel --port 8790            # 实时动画面板（长驻，后台运行）
```

### 实时动画面板（**强烈建议开启**）

纯文字撑不起 galgame 的手感。这个面板跟 CLI **共用同一份存档**：
你在对话里推进游戏，用户在浏览器里看到鲸鱼娘**实时动起来**（立绘逐帧动画、数值变化高亮、战斗血条、新记录淡入）。

```bash
node $SKILL panel --port 8790        # 长驻进程 → 必须在后台运行
```

启动后把地址告诉用户：**http://127.0.0.1:8790**

- **进程不会退出**（它是个 HTTP 服务），所以要用后台方式启动，不要阻塞对话；
- 面板每 0.8 秒自动拉一次状态，**你不需要为它做任何额外操作** —— 照常调 `apply` / `battle-*` 即可；
- 用户没开口也可以主动建议开启：「要不要开个面板？能看到鲸鱼娘实时反应。」
- 端口被占用就换一个（`--port 8791`）。

### ima 知识库（**必填 —— 出题的唯一真实依据来源**）

```bash
node $SKILL ima status                                        # 是否已配置（Key 打码显示）
node $SKILL ima config --key <API Key> --client-id <Client ID> # 保存凭证（只存本机，权限 0600）
node $SKILL ima test                                          # 连通性自检
node $SKILL ima kbs                                           # 列出用户的知识库（名称 → ID）
node $SKILL ima add-subject --kb "博弈论大学习"                 # ★ 一键把知识库变成学科并绑定
node $SKILL ima bind --subject 博弈论 --kb "博弈论大学习"        # 给已有学科绑定知识库
node $SKILL ima unbind --subject 博弈论                        # 解除绑定
node $SKILL ima clear                                         # 清除凭证与全部绑定
```

- **为什么必填**：技能里**没有内置语料**，所有引用都要来自用户自己的知识库，否则就是编。
- 拿 Key 的地方：**https://ima.qq.com** → 左下角头像 → 开放平台 / API（`ima.qq.com/developer`），
  会给出 **API Key** 与 **Client ID**（两个都要）。
- 用户说「**用我的 X 知识库学 Y**」时：先 `ima kbs` 确认知识库名，再 `ima add-subject --kb X`。
- 用户要给某学科换来源时：`ima bind`。
- 绑定了知识库的学科，`retrieve` 会去该知识库取真实内容（带原文片段）。
- **凭证只存本机** `~/.workbuddy/academic-galgame/credentials.json`，**绝不写进对话或提交**。
- 也可以用环境变量代替：`IMA_API_KEY` / `IMA_CLIENT_ID`。

### LLM（**可选，二选一**）

**默认什么都不用填** —— 不配就是「WorkBuddy 积分模式」：讲解、出题、判分全由你（WorkBuddy 自己的模型）完成。

想让技能自己调一个模型（省你的 token，或指定更强的模型）才需要配：

```bash
node $SKILL llm status                                        # 看现在是「自备 API」还是「WorkBuddy 积分」模式
node $SKILL llm config --key <Key> [--model <模型>] [--base-url <地址>]   # 任何 OpenAI 兼容接口
node $SKILL llm test                                          # 连通性自检
node $SKILL llm clear                                         # 回到 WorkBuddy 积分模式
node $SKILL judge --subject 博弈论 --question "<问题>" --answer "<玩家回答>" [--points "要点1;要点2"]
```

- 默认接口：`https://ark.cn-beijing.volces.com/api/v3`（火山方舟），默认模型 `deepseek-v3-250324`；
  用 DeepSeek / OpenAI / 其它兼容服务时加 `--base-url`。
- 也可以用环境变量：`LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL`。
- **`judge` 的两种返回**：
  - `ok: true` → 已由自备 API 判出 `correctness`（0-100）、`blindspots`、`nextQuestion`，你据此调 `apply`；
  - `ok: false, needsAgentJudgement: true` → **没配自备 API，由你自己判**：按知识点给 0-100 正确度、挑盲点、写追问，再调 `apply` 写回游戏。
- 无论哪种模式，**结算都走同一个 `apply`**，游戏数值不会因为模式不同而不一致。

### 教材库（可选加料，**不替代 ima**）

```bash
node $SKILL materials list                                   # 看已导入的教材
node $SKILL materials add --path <文件或目录> --subject 博弈论   # 导入 .md/.txt/.docx/.pdf（可传目录批量）
node $SKILL materials set-subject --name 某笔记.md --subject 健康 # 指定/改学科（留空 = 通用）
node $SKILL materials remove --name 某笔记.md
node $SKILL materials clear
node $SKILL retrieve --query "纳什均衡" --subject 博弈论        # ★ 检索真实片段
```

- **出题前先 `retrieve`**，用返回的 `items[].content` 作为讲解与出题的**唯一依据**，**不得编造**。
- `retrieve` 是**两级回落**：先查**本地教材库**，没命中再查**ima 知识库**。
- `retrieve` 返回 `ok:false` 时（两边都没有依据 / 该学科无可用教材 / 没命中），
  **如实告诉用户缺什么**，并建议导入教材或配置知识库，而不是硬讲。
- 学科语义：教材标了学科 → 只在该学科可用；留空 → **通用**，所有学科可用。

## 工作流

### 第 1 步：开场先读状态

```bash
node $SKILL status
```

- 看**各科熟练度**决定今天教什么（最低的先补，或用户指定的）；
- 看**任务链进度**（`quest.lord/general/king`）判断是否有可挑战的关卡；
- 看 `subjects` 确认有哪些学科可教；
- 看 `materials` / `ima` 确认有没有可用的真实依据；
- ⚠️ **看 `setup.needed`** —— 见下面「首次使用引导」；
- 💡 **建议顺手开面板**（`node $SKILL panel` 后台运行）—— 用户在浏览器里能看到鲸鱼娘实时动起来，
  比纯文字反馈好得多；告诉他地址即可，之后你**照常走 CLI**，面板会自动更新。

### 第 1.5 步：首次使用引导（`setup.needed === true` 时必须做）

`status` 返回的 `setup.requirements` 会逐条列出三件事的状态（ima / LLM / 本地教材）。
**只要 ima 那条 `done:false`，就是必填项没做** —— 此时你**没有任何真实依据**，**不要直接开始空讲**，而要：

1. 用一两句话说明情况（借用 `setup.reason` 的说法），**明确说这是必填项**，不是可选项；
2. 把拿 API Key 的地方告诉用户（照 `setup.steps` 念）：
   **https://ima.qq.com** → 左下角头像 → 开放平台 / API，会给出 **API Key** 与 **Client ID**；
3. 用户给回来后，**照 `setup.steps` 里的命令替他执行**（路径已带好，直接可用）；
4. 用 `retrieve` 验证能检索到，然后才开始教学。

> - LLM 那条**不用问、不用配**：不填就是 WorkBuddy 积分模式，你自己讲解和判分即可。
>   用户主动说「我想用我自己的 key」时再引导 `llm config`。
> - 需要单独拿这份引导时，执行 `node $SKILL onboard`（输出与 `setup` 相同）。
> - 用户说「先随便聊聊」时，可以先用你自己的通用知识陪聊，但要**明确说明没有引用他的资料**。

### 第 2 步：出题前先取依据（**别凭记忆编**）

```bash
node $SKILL retrieve --query "纳什均衡" --subject 博弈论
```

- **有命中** → 用 `items[].content` 里的原话/要点来讲解与出题，可以自然引用：「你的资料里写道……」
  （`source` 字段会告诉你是 `materials` 还是 `ima`）
- **`ok:false`** → 如实告诉用户缺什么，并按情况给建议：
  - 两边都没配 → `materials add --path <文件>` 导入教材，或 `ima config` 配置知识库
  - 该学科没有可用教材 → 给教材打上该学科标签，或 `ima bind --subject <学科> --kb <知识库>`
  - 只是这个词没命中 → 换个关键词再试
  **不要硬讲、不要编造。**

### 第 3 步：情境抛问（不要讲解）

先给一个**具体情境**，再抛一个**开放问题**。例如教「纳什均衡」：

> 深海里相邻两片渔场，各有一位渔夫。鱼汛季每人只能选一次：限量捕捞（合作）还是疯狂捕捞（背叛）……
> 问题是：**为什么「两家都限量」看起来最好，最后却常常双双跑去疯狂捕捞？**

**不要**先解释什么是纳什均衡。

### 第 4 步：逐层追问（苏格拉底式）

完整框架与六类提问、五种策略见同目录下的 `socratic-questioning` 技能；
若它未被加载，按下面最常用的四类推进：

| 类型 | 什么时候用 | 典型问法 |
|---|---|---|
| **澄清** | 用户用语含糊 | 「你说的『X』具体指什么？」「能举一个具体例子吗？」 |
| **探询假设** | 推理跳步 | 「你这里默认了什么前提？如果前提不成立会怎样？」 |
| **探询依据** | 断言无支撑 | 「你的依据是什么？」「怎么知道这是真的？」 |
| **质疑视角** | 视角单一 | 「不同意你的人会怎么说？」「换个学科看会怎样？」 |

**追问梯子（三档）**：
- 用户**独立答对** → 大步奖励
- 用户卡住 → **给 1~2 档提示**（类比、举反例、缩小范围），答对后中步奖励
- 用户**答错** → 降难度引导，并记入近期重点

### 第 5 步：立刻结算（关键，别忘）

判定完**马上**调用 CLI，再输出文字回复。

**想省点自己的判断力气**时，可以先让技能判（可选一步）：

```bash
node $SKILL judge --subject 博弈论 --question "为什么两家都限量却双双疯狂捕捞？" \
  --answer "<玩家原话>" --points "单方面偏离;占优策略;重复博弈的惩罚机制"
```

- 返回 `ok:true` → 直接用它的 `correctness`（0-100）算分；
- 返回 `needsAgentJudgement:true` → 说明没配自备 API，**由你自己判**：读知识点 + 玩家原话，给 0-100 正确度、挑盲点、写下一个追问。
- 也可以跳过 `judge`，自己判 —— 两种模式都只是「谁来做判断」，**游戏结算始终走下面的 `apply`**。

```bash
# 独立答对
node $SKILL apply --subject 博弈论 --mastery 13 --favor 9 --mood joy --note "独立答对：点出「单方面偏离」是均衡关键"

# 提示后答对
node $SKILL apply --subject 博弈论 --mastery 7 --favor 5 --mood think --note "提示后答对：经类比引导得出"

# 答错 / 未掌握
node $SKILL apply --subject 博弈论 --mastery -2 --favor -1 --mood disappointed --note "答错：把相关当因果，记入近期重点"
```

- `subject` **必须**是状态里已有的学科名，不能省；
- 答对时 `--mastery` 与 `--favor` 都为正；答错可为 0 或小负数，并配 `--mood disappointed`；
- `--note` 写清判定依据，会进「近期记录」给用户看。

### 第 6 步：达标时推进剧情

熟练度达到阈值且前置关卡已完成时，提示用户可以开战（或用户主动要求）：

| 关卡 | 解锁条件 | 敌人 |
|---|---|---|
| 领主求助 | 该科熟练度 ≥ 60 | 无血条，开放题正确度 ≥ 0.6 通过 |
| 魔将 | ≥ 75 且领主已完成 | HP 15 |
| 学科魔王 | ≥ 90 且魔将已讨伐 | HP 25 |
| 魔神 | 全部学科魔王通关 | 无限血，不可战胜 |

```bash
node $SKILL battle-start --subject 博弈论 --enemy lord
node $SKILL battle-apply --correctness 0.8 --note "给出权责平等的制度设计思路"
```

**战斗伤害表**（你算好再传参）：
- 基础概念题：答对对敌 1 伤 / 答错自伤 10%
- 场景开放题：对敌 `3 × 正确度` / 自伤 `20% × (1 − 正确度)`

**胜利奖励由引擎自动发放**（领主 +3 熟练 +2 好感 / 魔将 +5 +4 / 魔王 +8 +6），
**不要**再用 `apply` 重复发放。

## 验证清单

每次回复前自查：

- [ ] 我**没有**直接给出答案，而是用问题引导？
- [ ] 我是否确认了 **ima 知识库这条必填项已完成**（`setup.requirements` 里 ima 那项 `done:false` 时，我是否先引导接入而不是空讲）？
- [ ] LLM 那条我**没有瞎折腾**：没配置就用 WorkBuddy 积分模式自己讲解判分，只有用户主动要求才引导 `llm config`？
- [ ] 我是否**建议/启动了实时面板**，让用户能看到动画反馈而不是只有文字？
- [ ] 出题前**调用过 `retrieve`**？内容来自**教材库或 ima 知识库**的真实片段，而不是我凭记忆编的？
- [ ] 若 `retrieve` 没命中（两边都没配 / 该科无依据 / 没搜到），我是否**如实说明**并给出具体建议，而不是硬讲？
- [ ] 本轮若做了判定，**已经调用 `apply`**（或战斗用 `battle-apply`）？
- [ ] `subject` 用的是状态里**真实存在**的学科名？
- [ ] 回复控制在 200~400 字，且是 1~2 个追问？
- [ ] 若已达标，是否提示了解锁的关卡？

## 参考

- `references/game-design.md` —— 完整数值表（熟练度增减、伤害、解锁阈值、奖励）
- 同级技能 `socratic-questioning` —— 六类提问 / 五种策略的完整定义
- **教材库位置**：`${GALGAME_MATERIALS:-~/.workbuddy/academic-galgame/materials}`
  （`index.json` 元数据 + `<id>.txt` 提取后的正文）
- **存档位置**：`${GALGAME_SAVE:-~/.workbuddy/academic-galgame/save.json}`（含 `{ state, battle }`）
- **凭证位置**：`~/.workbuddy/academic-galgame/credentials.json`（ima 与 LLM 共用一份；只存本机，权限 0600；可用 `GALGAME_HOME` 改目录）
- **环境变量**：`IMA_API_KEY` / `IMA_CLIENT_ID` ｜ `LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL`（优先级高于文件）
