# 学术galgame Agent · Python 版 🐋

> **纯标准库实现**（零第三方依赖，连测试都用 `unittest`）。同一套设计规格、同一套数值、同一份 12 项自测，
> 从 Node 版逐文件移植；**前端一行未改**，原样复用。
>
> 这是对「这套架构能不能换语言实现」的实证回答 —— 也是「泛用性」最硬的证据。

---

## 快速开始

```bash
# 1. 直接跑（无需 pip install，无需虚拟环境）
python run.py
# 浏览器打开 http://127.0.0.1:8787

# 2. 跑自测
python -m unittest discover -s tests -v
```

**未配置任何 API Key 时自动进入 DEMO 模式**：界面、教学引擎、数值系统、战斗、存档全部可用。

## 环境要求

| 项 | 要求 |
|---|---|
| Python | ≥ 3.8（开发验证于 3.14.1） |
| 第三方包 | **无**（`requirements.txt` 不存在，也不需要） |
| Node.js | **不需要** |

## 项目结构

```
academic-galgame-py/
├── engine/                  # 纯游戏逻辑（不发网络，可单独使用与测试）
│   ├── config.py            #   数值常量（唯一真源之一）
│   ├── game.py              #   状态机：等级/好感/熟练度/派生能力/日志
│   ├── battle.py            #   战斗：解锁链/伤害/濒死/败北/结算
│   ├── storage.py           #   Storage（文件）/ MemoryStorage（访客内存）
│   └── session.py           #   会话：把引擎能力暴露成一组方法
├── agent/                   # LLM 编排层
│   ├── persona.md           #   鲸鱼娘人设（系统提示，从 Node 版原样复制）
│   ├── llm.py               #   大模型客户端（urllib；任意 OpenAI 兼容端点）
│   ├── retriever.py         #   检索适配：上传教材 → ima 知识库 → 内置 corpus/
│   └── gm.py                #   GM：工具定义 + 调用循环 + DEMO 兜底
├── server/                  # 零依赖 HTTP 层（纯标准库）
│   ├── env.py               #   .env 加载器
│   └── server.py            #   ThreadingHTTPServer + 全部 /api/* 路由
├── web/                     # 前端 —— 从 Node 版**原样复制，未改一行**
├── corpus/                  # 内置教材语料（检索依据）
├── tests/
│   ├── test_smoke.py        #   12 项自测（对齐 Node 版 scripts/smoke.js）
│   └── test_server.py       #   HTTP 层 7 项自测（Python 版新增）
└── run.py                   # 启动入口
```

## 与 Node 版的对应关系

| Node | Python | 说明 |
|---|---|---|
| `src/engine/config.js` | `engine/config.py` | 纯数据，直译 |
| `src/engine/game.js` | `engine/game.py` | 纯函数，直译 |
| `src/engine/battle.js` | `engine/battle.py` | 抛错改为 `ValueError` |
| `src/engine/storage.js` | `engine/storage.py` | `node:fs` → `os`/`json` |
| `src/agent/llm.js` | `agent/llm.py` | `fetch` → `urllib.request` |
| `src/agent/retriever.js` | `agent/retriever.py` | 分词逻辑逐字对齐（中文单字 + 双字组合） |
| `src/agent/gm.js` | `agent/gm.py` | 工具定义与调用循环结构一致 |
| `src/server/server.js` | `server/server.py` | `node:http` → `ThreadingHTTPServer` |
| `src/web/**` | `web/**` | **完全未改**（哈希一致） |

## HTTP 接口

与 Node 版完全一致，前端才能零改动复用：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 运行模式、BYOK、服务端是否预置模型 |
| `GET` | `/api/state` | 完整游戏状态 |
| `POST` | `/api/chat` | 对话一次，body `{"message":"..."}` |
| `POST` | `/api/reset` | 重置进度 |
| `GET/POST/PATCH/DELETE` | `/api/corpus` | 用户自带教材的增删改查（`?id=` 删单个） |
| `POST` | `/api/ima/kbs` | 列出 ima 知识库（名称 → ID） |
| `POST/DELETE` | `/api/subjects` | 学科增删（`?name=`） |
| `POST` | `/api/test` | 连通性测试，body `{"kind":"llm"\|"ima"}`（旧值 `ark` 仍接受） |

**BYOK 请求头**（服务端不存储任何凭证）：
`x-llm-key` / `x-llm-model` / `x-llm-base` / `x-ima-key` / `x-ima-client-id` / `x-ima-kb-map`
（旧头 `x-ark-key` / `x-ark-model` / `x-ark-base` 仍兼容）

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 服务监听（局域网共享设 `HOST=0.0.0.0`） |
| `LLM_API_KEY` / `LLM_MODEL` | — | 大模型凭证；**公开部署请留空**（BYOK 各用各的） |
| `LLM_BASE_URL` | 火山方舟地址 | **留空即默认火山方舟**；任何 **OpenAI 兼容**端点都可替换，例如 DeepSeek 填 `https://api.deepseek.com` |
| `IMA_API_KEY` / `IMA_CLIENT_ID` / `IMA_KB_MAP` | — | ima 知识库（可选） |
| `GALGAME_SAVE` | `./data/save.json` | 文件存档路径（Web 端默认用内存存档，不受此项影响） |
| `GALGAME_CORPUS` | `./corpus` | 内置教材语料目录 |

> 规范名是 `LLM_*`。为兼容早期版本，`ARK_API_KEY` / `ARK_MODEL` / `ARK_BASE_URL` 仍作为别名生效（新配置请优先用 `LLM_*`）。

## 换模型（不绑定供应商）

客户端打的是标准 OpenAI 兼容端点：`POST {baseUrl}/chat/completions` + Bearer 鉴权。**改 Base URL 即可换供应商，代码不用动**：

| 供应商 | Base URL | 模型 ID |
|---|---|---|
| **DeepSeek** | `https://api.deepseek.com` | `deepseek-chat` | 
| 火山方舟（默认） | 留空 | `ep-…` 接入点 ID |
| 其它 OpenAI 兼容服务 | 它自己的地址 | 它自己的模型名 |

> 上表中的 DeepSeek 一行为**本机实测通过**（基础对话 / function calling / `tool_choice:none` / 完整教学回合 2 轮）。其余第三方服务**未实测**，仅按 OpenAI 兼容契约判断可用。

## 自测

```bash
python -m unittest discover -s tests -v
```

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `test_smoke.py` | **12** | 初始状态 / 教学结算与升级 / 解锁链前置校验 / 领主求助判定与发奖 / 魔将累积伤害击破 / 战斗态清空 / 撤退 / 存档读回 / 魔神解锁门槛 / 本地检索 / 重置 |
| `test_server.py` | **7** | health / state / chat(DEMO) / 学科增删 / 教材增删改查 / 静态资源 / 路径穿越拦截 |

## 已验证 / 未验证

**已验证**（本机实测）：

- 12 项引擎自测 + 7 项 HTTP 自测全部通过；
- 纯标准库：全项目零第三方 `import`（AST 静态扫描确认）；
- 真浏览器打开 `python run.py` 的页面，界面与 Node 版一致（前端未改一行）；
- **真实模型教学（DeepSeek）**：基础对话、`function calling`、`tool_choice:none`、完整教学回合 2 轮全部跑通——
  回合 1 抛情境且拒绝给答案，回合 2 真实触发 `ag_apply`（博弈论 +13 熟练、好感 +9、心情 joy、日志写入）。

**未验证**：

- 火山方舟其它模型、以及 DeepSeek 之外的第三方服务（按 OpenAI 兼容契约判断可用，但未实测）；
- ima 知识库绑定与教材拖拽中的服务端解析分支（本机无 ima 凭证）；
- Docker / 公网部署（Python 版未附带 Dockerfile）。

## 相对 Node 版的能力差异（如实说明）

| 能力 | Python 版 | 原因 |
|---|---|---|
| DSH 组合插件形态 | ❌ 不可移植 | 那是 Cordis/Node 插件体系 |
| 独立 Web 服务 | ✅ | `server/server.py` |
| Trae 项目约定 | ⚠️ 部分 | `.trae/` 与 `AGENTS.md` 指向原 Node 仓库 |
| `workbuddy/` 技能版 | ❌ 未移植 | 原版绑定 JS 引擎 |
| 前端 | ✅ 完全一致 | 原样复用，零改动 |

## 为什么 Python 版值得存在

不是为了替换 Node 版，而是为了证明一件事：
**这套作品的教学引擎、数值体系与协议契约，不绑定任何语言或运行时。**

- 同一套设计规格（`config.py` 与原 `config.js` 数值逐项对齐）
- 同一份验收标准（12 项自测逐条对应）
- 同一套 HTTP 契约（前端因此零改动）

换语言实现所需改动的，只有**语法**；架构、边界、接口一律保持。这就是「泛用性」的可执行证据。
