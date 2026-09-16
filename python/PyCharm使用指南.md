# 在 PyCharm 里使用

> 本文针对 **Python 版**（`python/` 目录）。全程不需要装任何第三方包 —— 这个项目零依赖。
>
> ⚠️ **如实说明**：写这份指南的机器上**没有装 PyCharm**，所以下面涉及界面的部分我给的是
> **通用路径**（不同 PyCharm 版本菜单文字可能略有差异），而**命令行行为、运行结果、报错内容**
> 都是在本机实测过的。如果你按哪一步找不到对应菜单，告诉我你的 PyCharm 版本，我再校准。

---

## 第 0 步：打开哪个文件夹？（最关键的一步）

打开 PyCharm → **Open** → 选择文件夹。你有两种选择：

| 你想做什么 | 打开这个文件夹 | 说明 |
|---|---|---|
| **只想用 / 改 Python 版** | `academic-galgame-agent/python` | 推荐。结构最干净 |
| **Python 版和 Node 版都想看** | `academic-galgame-agent`（仓库根） | 也可以。运行时指定脚本为 `python/run.py` |

> ✅ **无论打开哪个，运行结果都一样**。项目已做过处理：配置文件和教材目录都按
> 「文件自己的位置」查找，**不依赖 PyCharm 的工作目录设置**。
>
> 这一点是特意修的：早期版本按「当前工作目录」找 `.env`，如果你打开的是仓库根目录，
> 它会读到 Node 版 `.env` 里的真实密钥，**你以为在 DEMO 模式、实际却在消耗额度**。
> 现在不会了 —— 它只读自己这一份 `python/.env`。

---

## 第 1 步：配置 Python 解释器

1. 菜单 **File → Settings**（macOS 是 **PyCharm → Settings / Preferences**）；
2. 左侧展开 **Project: xxx → Python Interpreter**；
3. 右边点齿轮 → **Add Interpreter → Add Local Interpreter**；
4. 选 **System Interpreter**（用你已经装好的那个 Python），从下拉里挑一个 **3.8 以上**的版本；
   - 如果你在第 1 章装过 Python，这里通常能直接在下拉里看到；
   - 找不到的话，点 **...** 手动选路径，一般在 `C:\Users\你的用户名\AppData\Local\Programs\Python\Python3xx\python.exe`。
5. 点 **OK**。

**不需要装任何包**。这个项目零第三方依赖，所以 Interpreter 页面里的包列表保持原样就行。

> 如果右下角提示 "No interpreter configured"，点它直接进这个设置页。

---

## 第 2 步：让代码不报红（Mark as Sources Root）

打开 `run.py`，你可能会看到 `from server.server import main` 下面有**红色波浪线**，
提示「未解析的引用」。

**这不影响运行**（`run.py` 里已经手动把项目目录加进搜索路径了），但看着难受、也没有跳转。解决办法：

1. 左侧项目树里，右键点击 **`python` 这个文件夹**（如果你打开的是仓库根，就右键它里面的 `python/`）；
2. 选 **Mark Directory as → Sources Root**；
3. 红色波浪线消失，`Ctrl + 点击` 也能跳转了。

> 这一步只是让 IDE 更聪明，**不做也能跑**。

---

## 第 3 步：运行

打开 `run.py`，然后：

- **最简单**：在代码编辑区任意位置右键 → **Run 'run.py'**；
- **或者**：点右上角绿色的 ▶ 按钮。

**PyCharm 会在底部弹出一个 Run 窗口，显示：**

```
  [OK] 学术galgame Agent（Python 版）已启动

    请在浏览器打开：  http://127.0.0.1:8787
    模型来源：BYOK 模式（服务端未放任何 Key，由每位访客自带凭证）
    配置文件：D:\...\python\.env（不存在，已跳过）

    停止服务：在本窗口按 Ctrl + C
```

看到这些就说明**起来了**。

**然后打开浏览器**，访问 `http://127.0.0.1:8787`。

> 💡 **「配置文件：……（不存在，已跳过）」是正常的**，不代表出错。
> 它只是告诉你：没找到 `.env`，所以走 BYOK / DEMO 模式。
> 想让它用真模型，看下面「配置密钥」一节。

### 怎么停止

点 Run 窗口左侧的**红色方块 ■**（Stop 按钮）。

> ⚠️ **常见坑**：如果你改完代码直接再点 ▶ 运行，**旧的那个可能还在跑**，于是新进程会撞端口。
> 这个项目会明确报错提示你（不会静默失败），看到提示就先点 ■ 停掉旧的。
> 也可以在 Run 窗口右上角勾上 "Single instance"（部分版本叫 "Allow multiple instances" 的复选框，取消勾选）。

---

## 第 4 步：跑测试

这个项目自带 **19 项自动化测试**（12 项引擎 + 7 项 HTTP），**不联网、不花钱**，1 秒跑完。

1. 左侧项目树里右键 **`tests` 文件夹**；
2. 选 **Run 'Unittests in tests'**（有的版本是 **Run 'Python tests in tests'**）。

**预期输出：**

```
Ran 19 tests in 0.6s

OK
```

**如果没跑起来**，检查测试运行器设置：

- **File → Settings → Tools → Python Integrated Tools**；
- 把 **Default test runner** 设为 **Unittest**（不是 pytest，本项目用的是 Python 自带的 unittest）。

> 单个测试也能跑：在测试方法名左边点绿色小三角。

---

## 第 5 步：调试（可选，但很好用）

1. 在你想看的地方点一下行号右边 —— 会出现一个**红点**（断点）。比如
   `engine/game.py` 里的 `apply_teaching` 函数；
2. 点右上角的**小虫子图标 🐞**（Debug）而不是 ▶；
3. 程序会在断点处停下来，底部出现调试面板，可以看变量、单步执行。

**推荐第一个断点的位置**：`engine/game.py` 的 `apply_teaching()`。
在那里你能看到「学生答对 → 熟练度加多少 → 状态怎么变」的全过程。

---

## 配置密钥（用真模型而不是 DEMO）

有两条路，**任选一条**。

### 方式 A：在网页里填（推荐，最简单）

不用碰 PyCharm。启动后打开 `http://127.0.0.1:8787`，点右上角 **⚙ 设置**，
填 API Key / 模型 ID / Base URL，点「测试模型连接」，保存。

详见 **[新手部署教程.md](./新手部署教程.md)** 第 5 步。

### 方式 B：在 PyCharm 里建 `.env` 文件

1. 项目树里右键 **`python`** 文件夹 → **New → File**；
2. 文件名输入 `.env`（**注意前面有个点**）→ 回车；
3. 内容写：

```ini
LLM_API_KEY=你的密钥
LLM_MODEL=deepseek-chat
LLM_BASE_URL=https://api.deepseek.com
```

4. 重新运行。

> ⚠️ **`.env` 已被 `.gitignore` 忽略，不会被提交到 Git**。但请**永远不要**把真实密钥
> 写进 `.py` 代码文件里。
>
> 想让 PyCharm 对 `.env` 有语法高亮？装个 **EnvFile** 插件（Settings → Plugins 里搜）。
> 不装也能用，就是纯文本。
>
> 服务端配了密钥 = **任何人都能用你的额度**。只在自己电脑上用没问题，
> 打算公开部署的话请留空（看「局域网共享」那一节的警告）。

---

## 关于前端文件（`web/` 里的 JS / HTML / CSS）

| 你的 PyCharm | 打开 `web/app.js` 会怎样 |
|---|---|
| **Professional 版**，或 2025.1 之后的**统一版** | 有完整语法高亮、跳转、补全 |
| 较老的 **Community 版** | 当纯文本显示，没有高亮 —— **但不影响运行** |

如果你要改界面又用的是 Community 版，用 VS Code 打开 `web/` 会更舒服。
**运行本身不需要管这个**。

---

## 常用操作速查

| 我想… | 怎么做 |
|---|---|
| 启动 | 打开 `run.py` → 右键 → Run（或点 ▶） |
| 停止 | Run 窗口左侧的红色 ■ |
| 跑测试 | 右键 `tests` → Run 'Unittests in tests' |
| 调试 | 打红点 → 点 🐞 |
| 换端口 | Run 配置里加环境变量 `PORT=8788`（见下） |
| 打开终端 | 底部 **Terminal** 标签，等同于命令行 |
| 搜索文件 | **Shift + Shift**（Search Everywhere） |
| 全局搜内容 | **Ctrl + Shift + F** |

### 怎么加环境变量（比如换端口）

1. 右上角运行配置下拉框 → **Edit Configurations...**；
2. 左侧选中 `run.py`；
3. 找到 **Environment variables** 一栏，点右边的图标；
4. 加一行 `PORT` = `8788`，确定；
5. 重新运行，然后浏览器访问 `http://127.0.0.1:8788`。

---

## 常见问题

### ❓ 运行时报 `[X] 启动失败：端口 8787 已经被占用`

**上一次的运行还活着**（很常见：改了代码直接点 ▶）。

- 点 Run 窗口的红色 ■ 停掉；或者
- 换个端口运行（见上面「怎么加环境变量」）；
- 实在找不到是谁占的：关掉 PyCharm，重开。

### ❓ 运行窗口中文显示成乱码 `????`

你的控制台编码不是 GBK。两种解法，任选：

- 在 Run 配置的 **Environment variables** 里加 `PYTHONIOENCODING` = `utf-8`；
- 或者在 **Settings → Editor → File Encodings** 里把 **Project Encoding** 设为 `UTF-8`。

> 本项目源码已做过全量 GBK 安全性扫描，字符本身不会有问题，这纯粹是控制台的事。

### ❓ `from server.server import main` 报红

见第 2 步：把 `python` 文件夹 **Mark Directory as → Sources Root**。
**报红不影响运行**。

### ❓ 测试跑不起来 / 提示找不到测试

**Settings → Tools → Python Integrated Tools → Default test runner** 改成 **Unittest**。

### ❓ 浏览器打不开 / 显示无法访问

- Run 窗口还在跑吗？（停了就访问不了）
- 地址是 `http://127.0.0.1:8787`，注意是 **http** 不是 https，端口是 **8787**；
- 你在 Run 配置里改过 PORT 吗？改过就用新端口访问。

### ❓ 页面能开，但右上角一直显示橙色 `DEMO 模式`

说明密钥没生效。检查顺序：

1. `python/.env` 建了吗？文件名**前面有点**吗？（`env` 不行，必须 `.env`）
2. 三个变量名写对了吗？`LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL`；
3. 改完 `.env` 后**重新运行**了吗？（改文件不会自动生效，要重启服务）
4. 看 Run 窗口里的「**配置文件：**」那一行 —— 它显示的就是**实际读取的路径**，
   和你的文件对得上吗？

### ❓ 我想同时开两个实例

在 Run 配置的 Environment variables 里给其中一个设 `PORT=8788` 即可。
注意两个实例的**学习进度是各自独立的**（按访客隔离）。

---

## 顺便说：用 PyCharm 的终端也一样方便

底部的 **Terminal** 标签就是一个正常的命令行。在里面：

```bash
python run.py                          # 启动
python -m unittest discover -s tests   # 跑测试
```

**和用 PyCharm 的图形按钮效果完全一样**。哪个顺手用哪个。
