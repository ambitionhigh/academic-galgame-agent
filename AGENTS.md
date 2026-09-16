# AGENTS.md · 学术galgame Agent

本文件是面向 AI 智能体的项目级指令，兼容 TraeCode / Cursor / Claude Code 等支持 `AGENTS.md` 的工具。
（在 TraeCode 中需在 **设置 > 规则 > 导入设置** 打开「将 AGENTS.md 包含在上下文中」。）

## 这是什么项目

一个**开源、零依赖、可独立运行**的 AI 教学 galgame Agent。LLM 扮演「鲸鱼娘」老师，用**苏格拉底式提问**带玩家学知识点；学习成果量化为游戏数值（学科熟练度 / 好感度 / HP / 任务链），并逐科推进「领主 → 魔将 → 学科魔王 → 魔神」的战斗剧情。

## 运行方式

```bash
cp .env.example .env      # 填入 LLM_API_KEY 与 LLM_MODEL（任何 OpenAI 兼容接口都行）
node src/server/server.js # 打开 http://localhost:8787
```

没有 `LLM_API_KEY` 时自动进入 **demo 模式**（内置示例老师的苏格拉底提问，UI 与引擎照常可用）。

## 你在这个项目里的角色

当用户在本项目里提出需求时：

1. **先读规则**：`.trae/rules/` 下的项目规则（技术栈、分层、数值）是硬约束。
2. **教学相关**：任何涉及「老师怎么提问 / 怎么教学 / 怎么出题」的改动，先加载技能 `.trae/skills/socratic-questioning/SKILL.md`，严格按其中的六类提问、五种策略与硬约束实现。
3. **改数值**：只改 `src/engine/` 与 `.trae/rules/game-design.md`，并同步 `docs/DESIGN-SPEC.md`。
4. **保持零依赖**：不要为了省事引入 npm 包。

## 关键约束速查

- 运行时：Node ≥ 18，ES Modules，**零第三方依赖**。
- 分层：`engine/`（纯逻辑，不发网络）← `agent/`（LLM 编排）← `server/`（HTTP）；`web/` 只走 `/api/*`。
- 密钥：只从环境变量读取，**绝不写进代码或提交**。
- 文案与注释：中文。
- 提交信息：遵循 `.trae/rules/git-commit-message.md`。

## 目录地图

```
.trae/rules/      项目规则（Trae 自动加载）
.trae/skills/     项目技能（含 socratic-questioning）
src/engine/       游戏逻辑：状态机 / 战斗 / 存档
src/agent/        人设、大模型接口客户端（llm.js，任何 OpenAI 兼容服务）、GM 工具编排、检索适配
src/server/       零依赖 HTTP 服务 + 静态 UI
src/web/          基础 UI 前端（原生 HTML/CSS/JS + 鲸鱼娘立绘）
corpus/           本地教材语料（检索依据，可选接 ima 知识库）
docs/             设计规格与迁移来源
```
