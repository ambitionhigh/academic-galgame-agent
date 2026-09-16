# desktop/ · Windows 桌面版打包

把 [`python/`](../python/) 那套纯标准库实现打包成**双击即用**的 Windows 程序：
不用装 Python、不用装 Node、不用开命令行。

产出物：`desktop/release/academic-galgame-windows.zip`（约 10.8 MB）
—— 成品也已经放在 [`download/`](../download/)，给不折腾的人直接下。

---

## 三步上手（给使用者）

1. 解压
2. 双击 `学术galgame.exe`
3. 浏览器自动打开 → 右上角「⚙ 设置」填自己的大模型 Key

第一次运行会在桌面自动建一个带鲸鱼娘图标的快捷方式。

---

## 目录结构

```
desktop/
├── launcher.pyw              # 启动器本体（唯一的「新代码」）
├── make-icon.js              # 从鲸鱼娘立绘生成 .ico（纯 Node，零依赖）
├── app.ico                   # 由 make-icon.js 生成，构建时用（不进仓库）
├── 鲸鱼娘.ico                # 同上，中文名那份（进仓库，供直接使用）
├── release-files/
│   └── 使用说明.txt          # 打包进发行包的用户说明
├── build/
│   ├── build.ps1             # ★ 一键打包
│   ├── fetch-wheels.js       # 用 Node 下载 PyInstaller 的 wheel
│   └── install-wheels.js     # 解包 wheel（绕开 pip）
└── .wheels/ .pylibs/ dist/ release/   # 构建产物，均已 gitignore
```

---

## 构建

```powershell
cd desktop
.\build\build.ps1                 # 完整构建 → release\academic-galgame-windows.zip
.\build\build.ps1 -SkipDeps       # 已装过 PyInstaller 时更快
.\build\build.ps1 -NoZip          # 只组装目录
```

需要：**Node ≥ 18**（只用来下 wheel 和生成图标）+ **Python ≥ 3.8**（打包机用）。
最终产物不依赖这两者中的任何一个。

---

## 启动器做了什么

```
双击 exe
   │
   ├─ 已经在跑？ ──→ 直接打开浏览器（第一次还会自动进「⚙ 设置」页）
   │
   ├─ 挑一个没被占用的端口（默认 8787，最多往后找 40 个）
   ├─ 用 --serve 模式把自己再拉起一个进程（脱离父进程，日志写文件）
   ├─ 轮询 /api/health 直到就绪（最多 45 秒）
   ├─ 没配大模型 → 浏览器开到 #settings，不让人停在 DEMO
   ├─ 第一次运行 → 在桌面建快捷方式（含鲸鱼娘图标）
   └─ 打开浏览器，退出（服务继续在后台跑）
```

命令行开关：

| 开关 | 作用 |
|---|---|
| `--port 9000` | 指定端口 |
| `--no-browser` | 只起服务，不开浏览器 |
| `--no-shortcut` | 不建桌面快捷方式 |
| `--shortcut` | 只（重新）建桌面快捷方式 |
| `--selftest` | 自检：路径 / 资源 / 模块 / 端口，并写出报告文件 |
| `--stop` | 停掉正在运行的服务 |
| `--console` | 在当前窗口里前台跑（`排查模式.bat` 用） |
| `--serve` | 内部用，真正跑服务的那个进程 |

---

## 用到的环境变量

| 变量 | 作用 |
|---|---|
| `GALGAME_PORT` | 默认端口 |
| `GALGAME_ENV` | 指定 `.env` 路径（默认：exe 旁边 / 开发时 `python/.env`） |
| `GALGAME_DESKTOP` | 覆盖「桌面」目录（测试用，或桌面被重定向到奇怪位置时） |

服务端自身的环境变量（`PORT` / `LLM_API_KEY` / `IMA_*` 等）见
[`python/README.md`](../python/README.md#配置环境变量)。

---

## 踩过的坑（改这个目录前务必读）

这些全是实际调试出来的，不是理论。

### 1. 这台机器上 pip 装不了东西

`pip install` 连 PyPI 会卡死（Node 的 `fetch` 却完全正常），而且沙箱下 pip 写临时目录会
`WinError 5 拒绝访问`。

**所以**：`fetch-wheels.js` 用 Node 的 `fetch` 直接拉 wheel，`install-wheels.js` 自己解 zip
（wheel 本质就是 zip，把 `*.data/{purelib,platlib,scripts}` 摆到正确位置即可），全程不碰 pip。

### 2. `.ps1` 含中文必须带 UTF-8 BOM

Windows PowerShell 5.1 没有 BOM 就按 ANSI（GBK）读脚本，中文会被拆坏，
连字符串的闭合引号都会被吃掉，报一堆莫名的 `Unexpected token`。

> ⚠️ 本项目用的编辑工具会**自动去掉 BOM**，所以每次改完 `build.ps1` 都要补回来：
> ```powershell
> $f = "...\build.ps1"
> $c = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)
> [IO.File]::WriteAllText($f, $c, (New-Object Text.UTF8Encoding $true))
> ```

### 3. `.bat` 必须同时满足三件事

| 要求 | 原因 |
|---|---|
| **GBK 编码** | cmd.exe 在中文 Windows 上按 ANSI 读批处理，存 UTF-8 会乱码 |
| **CRLF 换行** | 只有 LF 时 cmd 会把每行拆错，报 `'/d' is not recognized` |
| **开头 `chcp 936`** | cmd 是「边读边用当前代码页解码」的；系统默认代码页不是 936 时，连 `学术galgame.exe` 这个文件名都解析不出来 |

打包脚本里的 `Write-Bat` 一次把这三件事都做了。

### 4. PyInstaller 不吃中文路径参数

`--icon 鲸鱼娘.ico` 会变成 `ERROR: Unable to find '...\������.ico'`。
**解法**：构建时统一用 ASCII 名（`app.ico`），构建完再把 exe 改名回中文 —— 改名是安全的。

`--add-data` 的相对路径是相对 **specpath** 解析的，一律传绝对路径。

### 5. `print()` 在无控制台的 exe 里是静默丢弃

PyInstaller `--noconsole` 下 `sys.stdout is None`，`print` 什么也不做。
所以 `log_to()` 同时写一份日志文件到数据目录。

### 6. 弹窗是模态的，会卡死排查

`MessageBoxW` 会一直等到用户点确定。所以只在**真的没有输出窗口时**才弹。

### 7. `attach_console()` 不能抢已有的 stdout

用户把输出重定向到文件时（`自检.bat > out.txt`），`sys.stdout` 就是那个文件；
此时改成写 `CONOUT$` 会让重定向结果变成空白。所以只在 stdout 为 `None` 时才接管。

### 8. 杀进程：`taskkill` 会被拒，Win32 API 不会

某些受限环境里 `taskkill /F` 返回 `Access denied`，而同进程直接调
`OpenProcess` + `TerminateProcess` 却成功。`kill_pid()` 做了三级兜底：
Win32 API → taskkill → PowerShell `Stop-Process`。

### 9. 中文 Windows 控制台是 GBK，`⚙` 这类字符会让程序崩

`print('⚙ 设置')` 在 GBK 控制台直接抛 `UnicodeEncodeError`。
启动器开头就 `sys.stdout.reconfigure(errors='replace')`
（`python/run.py` 里也有同样的防护）。

### 10. 冻结后 `__file__` 的指向

打包后模块的 `__file__` 落在 `_MEIPASS` 下，而 `python/` 里几处资源路径是
用 `__file__` 相对推出来的，所以 `--add-data` 的目标位置必须对齐：

| 源码位置 | 读取方式 | `--add-data` 目标 |
|---|---|---|
| `server/server.py` | `dirname(__file__)/../web` | `web` → `_MEIPASS/web` |
| `agent/retriever.py` | `dirname(dirname(__file__))/corpus` | `corpus` → `_MEIPASS/corpus` |
| `agent/gm.py` | `dirname(__file__)/persona.md` | `agent` → `_MEIPASS/agent/persona.md` |

改完用 `学术galgame.exe --selftest` 验证，它会逐项检查这些路径。

### 11. 别用 `curl -o NUL` 做启动探测（这一条是给自己人的警告）

这个项目的模型是：启动器起一个脱离父进程的服务，然后自己退出
（和你桌面那个 `launch-dsh.vbs` 完全一样的套路）。**实测它是可靠的** ——
服务在启动器退出后继续存活，跨多条命令都还在。

但开发时我们一度误判成「服务被回收 / 启动要 60 秒」，原因是探测写法有问题：

```powershell
# ✗ 在受限环境里会稳定返回 000，让你以为服务没起来
& curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:8787/api/health

# ✓ 用 Python 的 urllib 探测，和启动器内部用的是同一套，结果可信
python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8787/api/health',timeout=3).status)"

# ✓ 或者把 body 丢到真实文件，别用 NUL 设备
& curl.exe -s -o "$env:TEMP\probe.txt" -w "%{http_code}" http://127.0.0.1:8787/api/health
```

用可信写法实测的结果：**从桌面快捷方式冷启动到就绪只要 0.7 秒**。

> 启动时仍然带了 `CREATE_BREAKAWAY_FROM_JOB`（当前 job 不允许时自动回退）：
> 不在 job 里时系统会忽略它，在某些宿主里则能防止服务被一起收走 —— 纯保险。

---

## 验证清单

改完启动器或打包脚本后，按顺序跑一遍：

```powershell
# 1. 开发模式自检
python launcher.pyw --selftest

# 2. 构建
.\build\build.ps1 -SkipDeps

# 3. 从仓库外解压再跑（这才是用户的真实路径）
tar -x -f release\academic-galgame-windows.zip -C <某个仓库外的目录>
<该目录>\学术galgame\学术galgame.exe --selftest

# 4. 真的启动一次，确认首页和立绘都取得到
<该目录>\学术galgame\学术galgame.exe --no-browser
curl http://127.0.0.1:8787/api/health
curl -o NUL -w "%{http_code}" http://127.0.0.1:8787/
curl -o NUL -w "%{http_code}" http://127.0.0.1:8787/assets/whale-girl/idle.png

# 5. 停止
<该目录>\学术galgame\学术galgame.exe --stop

# 6. 快捷方式（改到临时目录验证，别污染真桌面）
$env:GALGAME_DESKTOP = "$env:TEMP\fakedesk"
<该目录>\学术galgame\学术galgame.exe --shortcut
```

---

## 重新生成图标

```bash
node make-icon.js                                  # 默认：think.png 裁头部
node make-icon.js --src idle.png --crop 56,18,150,150
node make-icon.js --full                           # 不裁剪，用整张立绘
```

裁剪参数是 `x,y,宽,高`（源图是 256×256 的立绘）。
小尺寸图标会糊是正常的 —— 插画缩到 16px 都这样，Windows 会优先用 48/256 那几档。
