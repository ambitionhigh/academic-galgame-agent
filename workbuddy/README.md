# 工作伙伴（WorkBuddy）版 · 学术galgame

把「学术galgame」做成 **WorkBuddy 技能包**：安装后，WorkBuddy 就变成一位**用苏格拉底式提问教学**的鲸鱼娘老师，
每次判定都会写进学科熟练度与好感度，达标后解锁领主 → 魔将 → 学科魔王的考试剧情。

> 与 Trae 版的区别：Trae 版是**一个完整项目**（带 Web UI，`.trae/rules` + `.trae/skills`）；
> WorkBuddy 版是**两个可安装的技能**，不含 UI，游戏状态由技能内嵌的 CLI 维护。

---

## 一、安装

### 方式 A：本地安装脚本（推荐，不依赖外网）

```powershell
# Windows
cd workbuddy
.\install.ps1
```

```bash
# macOS / Linux
cd workbuddy
chmod +x install.sh && ./install.sh
```

脚本会把 `skills/` 下的两个技能复制到 **`~/.workbuddy/skills/`**：

```
~/.workbuddy/skills/
├── academic-galgame/          # 主技能：鲸鱼娘老师 + 游戏状态 CLI
│   ├── SKILL.md
│   ├── scripts/
│   │   ├── galgame.js         # 状态 CLI（status / apply / battle / …）
│   │   └── engine/            # 内嵌游戏引擎（状态机 / 战斗 / 配置）
│   └── references/
│       └── game-design.md     # 完整数值表
└── socratic-questioning/      # 提问框架技能（六类提问 / 五种策略）
    └── SKILL.md
```

### 方式 B：生态 CLI 安装（需要能访问 GitHub）

```bash
npx skills add <owner>/<repo>@academic-galgame -g -y
```

### 安装后确认

```bash
ls ~/.workbuddy/skills/            # macOS / Linux
dir %USERPROFILE%\.workbuddy\skills  # Windows
```

应能看到 `academic-galgame` 与 `socratic-questioning` 两个目录。

---

## 二、使用

打开 WorkBuddy，直接说需求即可（技能会自动匹配）：

```
开始教学，我想学纳什均衡
考考我博弈论
看看我的学习进度
加一门「博弈论大学习」
我想挑战领主
```

也可以 **@技能名** 手动触发：

```
@academic-galgame 看看我的进度
@socratic-questioning 帮我用提问的方式想清楚这个选题
```

### 它会怎么教

1. 先 `status` 读进度，决定今天教什么；
2. **抛一个具体情境**（例如「两片渔场，限量还是疯狂捕捞？」），**不直接讲定义**；
3. 按六类提问逐层追问；你卡住时给 1~2 档提示，答错则降难度并把该点记入近期重点；
4. **每次判定立刻写进游戏数值**（熟练度 / 好感度 / 心情）；
5. 达标时提示可以挑战领主 / 魔将 / 学科魔王。

---

## 三、游戏状态 CLI

技能通过这个 CLI 读写全部游戏状态（输出 JSON，便于智能体解析）：

```bash
SKILL=~/.workbuddy/skills/academic-galgame/scripts/galgame.js

node $SKILL status
node $SKILL apply --subject 博弈论 --mastery 13 --favor 9 --mood joy --note "独立答对"
node $SKILL add-subject --name "博弈论大学习"
node $SKILL remove-subject --name "投资"
node $SKILL battle-start --subject 博弈论 --enemy lord
node $SKILL battle-apply --correctness 0.8
node $SKILL battle-retreat
node $SKILL reset
node $SKILL help
```

| 命令 | 说明 |
|---|---|
| `status` | 等级 / HP / 好感度 / 各科熟练度 / 任务链 / 进行中的战斗 |
| `apply` | 教学结算：`--subject` 必填，`--mastery` `--favor` `--hp` `--mood` `--note` 可选 |
| `add-subject` / `remove-subject` | 增删学科（至少保留一个） |
| `battle-start` | 开战；`--enemy` = `lord` / `general` / `king` / `demon` |
| `battle-apply` | 结算一次攻击；`--correctness`（0~1）、`--damage-enemy`、`--damage-self` |
| `battle-retreat` | 撤退，清战斗态，无惩罚 |
| `reset` | 重置全部进度 |

**存档位置**：`~/.workbuddy/academic-galgame/save.json`（可用环境变量 `GALGAME_SAVE` 覆盖）
存档里同时保存**战斗态** —— 因为 CLI 每次调用都是独立进程。

---

## 四、自检（不依赖 WorkBuddy，直接用 CLI 验证）

```bash
SKILL=~/.workbuddy/skills/academic-galgame/scripts/galgame.js
export GALGAME_SAVE=/tmp/galgame-test.json    # 用临时存档，别污染真实进度

node $SKILL status
node $SKILL apply --subject 博弈论 --mastery 60
node $SKILL battle-start --subject 博弈论 --enemy lord
node $SKILL battle-apply --correctness 0.8
node $SKILL status      # 应看到：领主✓、熟练度 +3、好感 +2
```

---

## 五、数值速查

| 档位 | 熟练度 | 好感度 | 心情 |
|---|---|---|---|
| 独立答对 | +12 ~ +15 | +8 ~ +10 | `joy` |
| 提示后答对 | +6 ~ +9 | +4 ~ +6 | `think` |
| 答错 | 0 或小降 | 微降或 0 | `disappointed` |

| 敌人 | HP | 解锁条件 | 奖励（熟练 / 好感） |
|---|---|---|---|
| 领主 | 无血条（正确度 ≥ 0.6） | 熟练度 ≥ 60 | +3 / +2 |
| 魔将 | 15 | ≥ 75 且领主已完成 | +5 / +4 |
| 学科魔王 | 25 | ≥ 90 且魔将已讨伐 | +8 / +6（★） |
| 魔神 | ∞ | 全科魔王通关 | 0 / +1（暗线） |

完整数值见 `skills/academic-galgame/references/game-design.md`。

---

## 六、卸载

删除技能目录即可（存档保留，想彻底清掉再删存档）：

```powershell
Remove-Item "$HOME\.workbuddy\skills\academic-galgame" -Recurse -Force
Remove-Item "$HOME\.workbuddy\skills\socratic-questioning" -Recurse -Force
Remove-Item "$HOME\.workbuddy\academic-galgame" -Recurse -Force
```

---

## 七、与主项目的关系

| | Trae 版（主项目） | WorkBuddy 版（本目录） |
|---|---|---|
| 形态 | 完整项目：Node 服务 + Web UI | 两个技能包（无 UI） |
| 教学引擎 | `src/engine/` | `skills/academic-galgame/scripts/engine/`（同步副本） |
| 界面 | galgame Web 界面（立绘 / 属性面板 / 战斗浮层） | 无，全部走对话 |
| 触发方式 | 打开网页 | WorkBuddy 自动匹配或 `@技能名` |
| 模型来源 | 用户自带火山方舟 Key | **WorkBuddy 自身模型** |

> ⚠️ `scripts/engine/` 是从主项目 `src/engine/` **同步的副本**。改动主项目引擎后请重新复制：
> ```powershell
> Copy-Item src\engine\config.js,src\engine\game.js,src\engine\battle.js `
>   workbuddy\skills\academic-galgame\scripts\engine\ -Force
> ```
