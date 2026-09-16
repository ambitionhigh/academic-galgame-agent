---
alwaysApply: true
---

# 学术galgame Agent · 项目规则

本项目是一个**开源、可独立运行**的 AI 教学 galgame Agent：由 LLM 扮演「鲸鱼娘」老师，用**苏格拉底式提问**带玩家学知识点，并把学习成果量化为游戏数值（学科熟练度 / 好感度 / HP / 任务链）。

## 技术栈约束

- **运行时**：Node.js ≥ 18，**零运行时依赖**（只用 `node:` 内置模块）。不要引入 express、openai 等第三方包；如需 HTTP 客户端直接用全局 `fetch`。
- **模块**：源码统一使用 **ES Modules**（`package.json` 中 `"type": "module"`），import 必须带 `.js` 扩展名。
- **前端**：原生 HTML/CSS/JS（无构建步骤、无框架）。放在 `src/web/`，由 `src/server/server.js` 静态伺服。
- **模型后端**：统一走**标准 OpenAI 兼容接口**（`POST {baseUrl}/chat/completions` + Bearer 鉴权），经 `src/agent/llm.js` 调用。**不绑定任何供应商**（DeepSeek / 火山方舟 / OpenAI 皆可），火山方舟只是 `LLM_BASE_URL` 留空时的默认值。禁止把 API Key 写进代码。

## 分层规则

| 目录 | 职责 | 约束 |
|---|---|---|
| `src/engine/` | 纯游戏逻辑（状态机、战斗、存档） | **不得** import `src/agent/` 或 `src/server/`；不得发起网络请求 |
| `src/agent/` | LLM 编排（人设、工具、检索） | 只依赖 `engine/`；所有模型调用经 `llm.js` |
| `src/server/` | HTTP 服务与静态资源 | 不含业务规则，只做编排与转发 |
| `src/web/` | UI 前端 | 只通过 `/api/*` 与后端通信 |

## 数值改动规则

游戏数值（熟练度增减、伤害表、解锁阈值、奖励）**只能**定义在 `src/engine/` 与 `.trae/rules/game-design.md` 中，且两处必须同步。改数值时必须同时更新 `docs/DESIGN-SPEC.md` 的版本记录。

## 语言与风格

- 面向用户的所有文案、注释、提交信息使用**中文**。
- 回复玩家时用鲸鱼娘口吻：温柔、俏皮、带鲸鱼/深海小比喻。
- 提交信息遵循 `scene: git_message` 规则（见 `git-commit-message.md`）。

## 安全与开源

- 密钥只从环境变量读取（`LLM_API_KEY` 等；旧名 `ARK_API_KEY` 仍兼容），`.env` 已在 `.gitignore` 中。
- 不提交任何个人凭证、存档文件（`*.save.json`）或 `node_modules`。
