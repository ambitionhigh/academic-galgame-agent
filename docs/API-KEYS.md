# API Key 获取与配置指南

本项目有**两条配置路径**，任选其一（也可以都用）：

| 路径 | 适用 | 凭证存放 | 服务端 |
|---|---|---|---|
| **① 页面里填（BYOK，推荐）** | 所有人；公开部署的访客 | 你的浏览器 localStorage | **不存储、不需要** |
| **② 环境变量 `.env`** | 自托管给自己玩 | `.env`（gitignore） | 作为访客未填时的兜底 |

**代码里没有任何硬编码凭证。**

---

## ① 页面里填（BYOK）—— 推荐

打开应用页面 → 右上角 **「⚙ 设置」**：

1. **① 大模型接口**：填 API Key + 模型 ID（火山方舟填 `ep-…` 接入点 ID、Base URL 留空即可；DeepSeek 填 `deepseek-chat` + `https://api.deepseek.com`）→ 点「测试模型连接」→ 通过后保存
2. **② ima 知识库**（可选）：填 API Key + Client ID + 学科→知识库ID 映射 → 点「测试 ima 连接」
3. 点 **「保存到本机浏览器」**

### 凭证去哪了

```
你的浏览器(localStorage) ──HTTP头──▶ 本站服务 ──▶ 大模型接口 / ima
                                        ↑
                                  仅用于当次请求，不落盘、不记录
```

- 只存在**你自己的浏览器**；换电脑/换浏览器要重填（有意如此）。
- 服务端**不存储**，公开部署的站点主不需要放任何 Key。
- 随时点「清空凭证」抹掉。

> ⚠️ 浏览器扩展、公共电脑等场景下 localStorage 可能被读取 —— 在不受信任的设备上别填。

### 学科 → 知识库：**从你的知识库直接生成课程表**

**不用自己去查任何 ID。** 填好 API Key + Client ID 后：

1. 点设置面板里的 **「拉取知识库列表」** —— 系统会调 ima 的 `get_addable_knowledge_base_list` 把你有权限的知识库列出来；
2. 每个知识库右侧点 **「+ 添加为学科」** —— 该知识库立刻成为一门可学的学科，**并自动绑定**；
3. 想调整绑定关系，去 **「③ 我的学科」**：每个学科右侧的下拉框可换绑、解绑（选「未绑定知识库」）。

于是**你的课程表就是你 ima 知识库的镜像**：你库里有什么，游戏里就能学什么。

- 也可以手动添加学科（③ 里的输入框，或主面板学科标题旁的 **＋**）；
- 删除学科用 ③ 里的 `×`（会连带删掉该学科的熟练度与任务链；**至少保留一个**）。
- 想手动改映射：展开「高级：直接编辑映射 JSON」，写
  ```json
  { "博弈论大学习": "kb-id-1", "社会科学": "kb-id-2" }
  ```
  键是**学科名**，值是 ima 的 `knowledge_base_id`；该映射含中文，前端会自动做 percent-encoding（HTTP 头只能承载 ASCII）。

### ③ 连 ima 都不需要：直接传自己的教材

设置面板第三块 **「我的教材」** 可以把文件**拖进虚线框**（或点击选择，可多选、可分多次追加，同名文件自动覆盖）。上传后：

- **支持格式**：`.md` / `.txt` / `.docx`（可靠）；`.pdf`（实验性，扫描件或特殊字体可能失败并给出提示）；
- 文本在**浏览器端**提取（零依赖、零上传），正文存进服务端**本会话内存**（不写磁盘）；
- **刷新不丢**：同时镜像到**你浏览器的 IndexedDB**，重开浏览器会自动恢复到当前会话；
- 老师检索时**优先**读这些资料（顺序：上传教材 → ima → 内置 `corpus/`）；
- **可按学科指定**：每个文件右侧下拉框选「通用（所有学科）」或某个具体学科。指定后该文件**只**在对应学科下被检索，教别的科目不会串味；
- 可单个删除（`×`）或一键清空（会一并删除浏览器本地副本）。

限制：单文件 ≤ 40 万字符，每会话合计 ≤ 200 万字符，单次最多 30 个文件。

---

## ② 环境变量（自托管兜底）

只有当访客**没在页面里填**时，才会用到服务端这套缺省值。适合「自己给自己用」的本地部署。

> 🔒 `.env` 已被 `.gitignore` 忽略，**永远不会进入 Git 仓库**。也请不要把密钥写进任何 `.js` 文件、截图或聊天记录。
> **公开部署请留空**，否则等于把你的额度开放给所有访客。

```powershell
Copy-Item .env.example .env
notepad .env          # 填入下面的值
npm run check:llm     # 自检：确认 Key + 模型 ID + Base URL + 网络都通（旧脚本名 check:ark 仍可用）
npm start             # 通过后启动
```

---

## 一、大模型接口 —— 想用真模型就必须配

项目打的是**标准 OpenAI 兼容接口**（`POST {baseUrl}/chat/completions` + `Bearer` 鉴权），**不绑定任何供应商**：
DeepSeek、火山方舟、OpenAI、本地推理服务……只要接口兼容就能接。不配也能跑，但会进入 **DEMO 模式**（只有内置示例提问，不是真模型）。

已实测两条路：

| 服务 | Base URL | 模型 ID |
|---|---|---|
| **DeepSeek** | `https://api.deepseek.com` | `deepseek-chat`（或其它 DeepSeek 模型名） |
| **火山方舟**（默认值） | 留空即 `https://ark.cn-beijing.volces.com/api/v3` | `ep-…` 开头的推理接入点 ID |

> 其它 OpenAI 兼容服务**理论可用**（接口形状相同），本项目未逐一实测。

### 需要拿到三个值（第三个可留空）

| 变量 | 是什么 | 从哪拿 |
|---|---|---|
| `LLM_API_KEY` | 你的身份凭证 | 你选的服务方的控制台（DeepSeek / 火山方舟 …） |
| `LLM_MODEL` | 调哪个模型 | 服务方的模型名（如 `deepseek-chat`）；火山方舟填**接入点 ID**（`ep-…`） |
| `LLM_BASE_URL` | 接口地址 | 服务方给的地址；**留空 = 按模型名自动识别**（deepseek-chat → DeepSeek，ep-… → 火山方舟） |

### 步骤（以火山方舟为例；用 DeepSeek 则只需在建 Key 后填 `LLM_MODEL=deepseek-chat` + `LLM_BASE_URL=https://api.deepseek.com`）

**1. 前置条件**
- 火山引擎账号（手机号注册）
- **完成实名认证** ← 没有它无法开通方舟，这是最常见的卡点

**2. 开通方舟**
打开 https://console.volcengine.com/ark → 首次进入按提示同意协议、开通服务。

**3. 创建 API Key**
左侧 **「API Key 管理」** → **创建 API Key** → 起个名字 → **立刻复制**。
> ⚠️ 很多平台只在创建时完整显示一次。建议一个用途一个 Key，泄露时好单独吊销。

**4. 创建推理接入点 → 拿到 `LLM_MODEL`**
左侧 **「在线推理」** → **创建推理接入点**：
- 名称随便填（如 `galgame-teacher`）
- 模型：从下拉里选（豆包 Doubao 系列通常最常用、最划算）
- 计费：**按量付费**（默认，适合试用）
- 若提示模型未开通 → 先去左侧 **「开通管理」** 开通该模型

创建完成后列表里会出现 **`ep-` 开头的接入点 ID**，复制它。
> 也可以直接填模型 ID（部分模型支持），但**推荐用接入点 ID**，绑定明确、行为稳定。

**5. 填入 `.env`**（下例为火山方舟；DeepSeek 用 `sk-…` + `deepseek-chat` + `https://api.deepseek.com`）

```ini
LLM_API_KEY=ark-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-xxxxx
LLM_MODEL=ep-20250101-xxxxx
LLM_BASE_URL=                                  # 留空则按模型名自动识别；也可显式写 https://api.deepseek.com 或 https://ark.cn-beijing.volces.com/api/v3
```

> 早期版本用的 `ARK_API_KEY` / `ARK_MODEL` / `ARK_BASE_URL` 仍然被识别，新配置请用 `LLM_*`。

**6. 自检**

```powershell
npm run check:llm
```

成功会打印：
```
✓ 调用成功！模型返回： "收到"
```

### 免费额度与计费

（火山方舟）左侧 **「免费推理额度」** 页面可查看账号的赠送额度（以页面实际显示为准）。各家计费方式不同，通常按**输入 + 输出的 token** 数计费，用多少算多少；本项目单次对话在几千 token 量级。

---

## 二、ima 知识库 —— 可选

默认情况下，老师从项目里的 `corpus/` 目录检索**本地教材**出题。如果你有腾讯 ima 知识库，可以用它替代：

```ini
IMA_API_KEY=你的 ima 开放接口 Key
IMA_CLIENT_ID=你的 ima Client ID
IMA_KB=默认知识库 ID
# 可选：按学科指定不同知识库
IMA_KB_MAP={"博弈论":"xxxx","社会科学":"yyyy"}
```

- 配置后 `ag_retrieve` 会**优先走 ima**，失败时自动回落到本地 `corpus/`。
- 不配置则完全使用本地语料，**无需任何外部依赖**。
- 若本地语料为空且未配 ima，检索会返回提示，老师仍可正常教学（只是没有外部依据）。

---

## 三、报错对照表

`npm run check:llm` 的报错含义：

| 报错关键字 | 真实原因 | 怎么修 |
|---|---|---|
| `401` / `AuthenticationError` / `invalid api key` | Key 错、没复制全，或 `.env` 没被读到 | 重新复制 Key；确认 `.env` 在**项目根目录**且文件名就是 `.env` |
| `404` / `model not found` / `InvalidEndpoint` | `LLM_MODEL` 写错，或模型/接入点未开通 | 核对模型名；火山方舟则核对 `ep-` 后面的字符，并去「开通管理」开通模型 |
| `403` / `AccessDenied` | 账号未实名，或该模型/服务未开通 | 完成实名认证；开通对应模型 |
| `429` / `RateLimit` / `quota` | 触发限流或额度用尽 | 稍后重试；或用尽后充值 |
| `ECONNRESET` / `timeout` / `fetch failed` | 网络或代理问题 | 确认能访问你填的 Base URL（默认方舟为 `ark.cn-beijing.volces.com`） |
| `LLM_NOT_CONFIGURED` | `.env` 根本没被读到 | 确认文件在项目根目录、名为 `.env`，且 `LLM_API_KEY` 与 `LLM_MODEL` 都不为空 |

---

## 四、安全规范（重要）

### 本项目怎么做的

| 措施 | 实现 |
|---|---|
| 密钥只从环境变量读 | `src/agent/llm.js` 用 `process.env.LLM_API_KEY`（旧名 `ARK_API_KEY` 也认），**代码里没有任何 Key** |
| `.env` 不进仓库 | `.gitignore` 第 5 行包含 `.env` |
| 提供模板而非真值 | 仓库里只有 `.env.example`（值为空） |
| 存档与语料也不进仓库 | `.gitignore` 忽略 `data/` 与 `*.save.json` |

### 你应该做的

1. **只填 `.env`**，不要把 Key 写进 `.js`、README、issue 或截图。
2. **不要提交 `.env`**：如果 `git status` 里出现了 `.env`，立刻停下并检查 `.gitignore`。
3. **泄露就轮换**：一旦怀疑某 Key 外泄，去控制台删掉它、新建一个，然后更新 `.env` —— 旧的立即失效。
4. **一个用途一个 Key**：便于单独吊销，缩小影响范围。
5. **分享项目时**：给别人 `.env.example`，不要给 `.env`。

### 验证仓库里没有密钥

```powershell
git check-ignore -v .env          # 应输出「.gitignore:5:.env  .env」
git status --short                # 应没有 .env
git log -p --all | Select-String "ark-","sk-" -SimpleMatch   # 应无命中（历史里也没有）
```
