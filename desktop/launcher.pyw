#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""学术galgame · 桌面启动器（Python 版）

双击图标就完事：启动本地服务 → 打开浏览器。用户不需要懂任何命令。

发行包里已经把 Python 解释器和游戏代码一起打包好了（PyInstaller），
所以别人电脑上**不用装 Python、也不用装 Node**。

它做的事：
  1. 挑一个没被占用的端口；如果发现游戏已经在跑，就直接把浏览器打开
  2. 后台启动服务（本程序自己的 --serve 模式），日志写到本机日志目录
  3. 等它就绪（最多 45 秒），然后打开浏览器
  4. 还没填大模型 Key 时，直接把浏览器开到「⚙ 设置」页，避免停在 DEMO
  5. 第一次运行自动在桌面建一个带鲸鱼娘图标的快捷方式

命令行（一般用不到，出问题排查时才用）：
  --port 9000       指定端口
  --no-browser      只启动服务，不开浏览器
  --no-shortcut     不创建桌面快捷方式
  --console         在当前窗口里跑（配合 排查模式.bat 用）
  --stop            停止正在运行的学术galgame
  --serve           内部用：真正跑服务的前台进程
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

APP_NAME = "学术galgame"
APP_TITLE = "学术galgame · 鲸鱼娘老师"
DEFAULT_PORT = 8787
READY_TIMEOUT = 45
CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
IS_WINDOWS = os.name == "nt"
FROZEN = bool(getattr(sys, "frozen", False))


def _init_streams():
    """中文 Windows 控制台默认 GBK。遇到 ⚙ 这类 GBK 表示不了的字符，
    print 会直接抛 UnicodeEncodeError 把程序搞崩 —— 统一设成「编不了就替换」。
    （run.py 里有同样的防护，这里也必须有一份。）"""
    for name in ("stdout", "stderr"):
        try:
            getattr(sys, name).reconfigure(errors="replace")
        except Exception:
            pass


_init_streams()


# ══════════ 路径 ══════════

def resource_dir() -> Path:
    """只读资源目录。打包后是 PyInstaller 的解包目录（web/、corpus/ 都在这里）。"""
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def install_dir() -> Path:
    """程序所在目录（exe 或 launcher.pyw 所在处）"""
    if FROZEN:
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def code_root() -> Path:
    """Python 包的根目录（里面要有 server/、agent/、engine/、web/）"""
    for cand in (resource_dir(),
                 resource_dir() / "python",
                 resource_dir().parent / "python",     # 开发时：<仓库根>/python
                 install_dir() / "python"):
        if (cand / "server" / "server.py").is_file():
            return cand
    # 打包后 server 模块在 PYZ 里、磁盘上没有 .py，靠这项兜底
    if FROZEN:
        return resource_dir()
    raise SystemExit("找不到游戏代码（server/server.py）")


def data_dir() -> Path:
    """放日志等可写文件的地方"""
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or str(Path.home())
    d = Path(base) / APP_NAME
    try:
        d.mkdir(parents=True, exist_ok=True)
        return d
    except OSError:
        d = Path(os.environ.get("TEMP", ".")) / APP_NAME
        d.mkdir(parents=True, exist_ok=True)
        return d


def _writable(d: Path) -> bool:
    try:
        probe = d / ".write-test"
        probe.write_text("", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def env_file() -> Path:
    """配置文件 .env 的位置。

    打包后：放在 exe 旁边（绿色版，删除文件夹就干净卸载）；不可写则退回本机数据目录。
    开发时：就是 <仓库根>/python/.env，和原有习惯一致。
    """
    if os.environ.get("GALGAME_ENV"):
        return Path(os.environ["GALGAME_ENV"])
    if FROZEN:
        beside = install_dir() / ".env"
        if beside.exists() or _writable(install_dir()):
            return beside
        return data_dir() / ".env"
    return code_root() / ".env"


def log_to(msg):
    """打包成 exe 且无控制台时 sys.stdout 是 None，print 会静默丢弃 → 同时写日志"""
    print(msg, flush=True)
    try:
        with open(data_dir() / "launcher.log", "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def attach_console():
    """GUI 子系统 exe 在没有可用输出流时，挂一个控制台出来。

    注意：**已经存在 stdout 时绝不接管** —— 用户把输出重定向到文件（`自检.bat > out.txt`）
    时 sys.stdout 就是那个文件，此时改成写 CONOUT$ 会让重定向结果变成空白。
    """
    if not IS_WINDOWS or not FROZEN:
        return
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        if not k32.AttachConsole(-1):      # 挂到父进程（cmd）的控制台
            k32.AllocConsole()             # 没有父控制台（双击 exe）就自己开一个
        if sys.stdout is None:
            sys.stdout = open("CONOUT$", "w", encoding="utf-8", errors="replace", buffering=1)
        if sys.stderr is None:
            sys.stderr = open("CONOUT$", "w", encoding="utf-8", errors="replace", buffering=1)
    except Exception:
        pass


def alert(title, text):
    """没有控制台时用系统弹窗（GUI 版 exe），有控制台就直接打出来。

    注意：MessageBox 是**模态**的，会一直等到用户点确定 —— 所以只在真的
    没有输出窗口时才弹，否则排查时会被它卡死。
    """
    log_to(f"[{title}] {text}")
    if IS_WINDOWS and sys.stdout is None:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, text, title, 0x40)
        except Exception:
            pass


# ══════════ 端口与服务 ══════════

def port_free(port) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port(preferred) -> int:
    if port_free(preferred):
        return preferred
    for p in range(preferred + 1, preferred + 40):
        if port_free(p):
            return p
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def health(port, timeout=1.5):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
            return data if data.get("ok") else None
    except Exception:
        return None


def find_running(preferred):
    """返回 (端口, health)；没在跑就返回 (None, None)"""
    for p in range(preferred, preferred + 40):
        h = health(p)
        if h:
            return p, h
    return None, None


def open_browser(url):
    try:
        import webbrowser
        webbrowser.open(url)
    except Exception:
        if IS_WINDOWS:
            try:
                os.startfile(url)  # noqa: S606
            except OSError:
                pass


def kill_pid(pid) -> bool:
    """结束一个进程。三级兜底：Win32 API → taskkill → PowerShell Stop-Process。

    只用 taskkill 是不够的：在某些受限环境（包括本项目的开发沙箱）里
    taskkill 会返回「Access denied」，但同进程直接调 Win32 却能成功。
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False

    # 一级：直接调 Win32（最可靠，不依赖外部程序）
    if IS_WINDOWS:
        try:
            import ctypes
            PROCESS_TERMINATE = 0x0001
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
            if h:
                ok = bool(k32.TerminateProcess(h, 0))
                k32.CloseHandle(h)
                if ok:
                    return True
        except Exception:
            pass

    # 二级：taskkill
    try:
        r = subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, text=True,
                           timeout=15, creationflags=CREATE_NO_WINDOW)
        if r.returncode == 0:
            return True
    except Exception:
        pass

    # 三级：PowerShell Stop-Process
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                            f"Stop-Process -Id {pid} -Force -ErrorAction Stop"],
                           capture_output=True, text=True, timeout=30, creationflags=CREATE_NO_WINDOW)
        if r.returncode == 0:
            return True
    except Exception:
        pass
    return False


def listeners(port):
    """找出正在监听该端口的进程号"""
    if not IS_WINDOWS:
        return []
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True,
                             timeout=15, creationflags=CREATE_NO_WINDOW).stdout
    except Exception:
        return []
    pids = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[3] == "LISTENING" and parts[1].endswith(f":{port}"):
            if parts[4] not in pids:
                pids.append(parts[4])
    return pids


def stop_running(port):
    """停掉监听该端口的服务"""
    if not IS_WINDOWS:
        return False, "只有 Windows 支持 --stop"
    pids = listeners(port)
    if not pids:
        return False, f"端口 {port} 上没有正在运行的服务"
    killed, failed = [], []
    for pid in pids:
        (killed if kill_pid(pid) else failed).append(pid)
    if killed and not failed:
        return True, f"已停止（进程 {', '.join(killed)}）"
    if killed:
        return True, f"部分停止：成功 {', '.join(killed)}，失败 {', '.join(failed)}"
    return False, f"停不掉进程 {', '.join(failed)}（可试着手动在任务管理器里结束它）"


# ══════════ 桌面快捷方式 ══════════

def desktop_dir() -> Path:
    # 允许显式指定（测试、或桌面被重定向到奇怪位置时）
    override = os.environ.get("GALGAME_DESKTOP")
    if override:
        return Path(override)
    # OneDrive 会把桌面重定向，优先用注册表里真实的桌面路径
    if IS_WINDOWS:
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders") as key:
                d = winreg.QueryValueEx(key, "Desktop")[0]
                if d:
                    return Path(d)
        except Exception:
            pass
    return Path.home() / "Desktop"


def find_icon():
    # 先看程序目录（快捷方式指向这里更干净），再看打包内部
    for base in (install_dir(), resource_dir()):
        for name in ("鲸鱼娘.ico", "app.ico", "icon.ico", "whale-girl.ico"):
            cand = base / name
            if cand.is_file():
                return cand
    return None


def make_shortcut(force=False):
    if not IS_WINDOWS:
        return None, "只有 Windows 需要桌面快捷方式"
    lnk = desktop_dir() / f"{APP_NAME}.lnk"
    if lnk.exists() and not force:
        return lnk, "已存在，跳过"

    icon = find_icon()
    if icon is None:
        return None, "找不到图标文件"

    if FROZEN:
        target, args, workdir = str(Path(sys.executable).resolve()), "", str(install_dir())
    else:
        pyw = Path(sys.executable).with_name("pythonw.exe")
        target = _short_path(str(pyw)) if pyw.is_file() else _short_path(sys.executable)
        args = f'"{_short_path(str(Path(__file__).resolve()))}"'
        workdir = str(Path(__file__).resolve().parent)

    ps = f"""$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut('{_ps(str(lnk))}')
$lnk.TargetPath = '{_ps(target)}'
$lnk.Arguments = '{_ps(args)}'
$lnk.WorkingDirectory = '{_ps(workdir)}'
$lnk.IconLocation = '{_ps(str(icon))},0'
$lnk.Description = '{APP_TITLE}'
$lnk.Save()
"""
    tmp = data_dir() / "_mklnk.ps1"
    # 带 BOM 存盘：Windows PowerShell 5.1 才会按 UTF-8 正确读取中文路径
    tmp.write_text(ps, encoding="utf-8-sig")
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(tmp)],
            capture_output=True, text=True, timeout=60, creationflags=CREATE_NO_WINDOW)
        if r.returncode != 0:
            return None, (r.stderr or r.stdout or "未知错误").strip()[:300]
        return lnk, "已创建"
    except Exception as e:
        return None, str(e)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _ps(s: str) -> str:
    return s.replace("'", "''")


def _short_path(p: str) -> str:
    """避免中文/空格路径在 .lnk 里出问题：取不到 8.3 短路径就原样返回"""
    if not IS_WINDOWS:
        return p
    try:
        import ctypes
        from ctypes import wintypes
        fn = ctypes.windll.kernel32.GetShortPathNameW
        fn.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
        buf = ctypes.create_unicode_buffer(600)
        n = fn(p, buf, 600)
        return buf.value if 0 < n < 600 else p
    except Exception:
        return p


# ══════════ 真正跑服务（前台进程） ══════════

def cache_dir() -> Path:
    """ima 知识库索引缓存（下载的书 + 抽出的正文）。

    必须落在**持久**位置：打包后 __file__ 指向 PyInstaller 的临时解包目录，
    用它做缓存等于每次启动都白下几十 MB 的书。
    """
    if FROZEN:
        beside = install_dir() / ".ima-cache"
        if _writable(install_dir()):
            return beside
        return data_dir() / "ima-cache"
    return code_root() / ".ima-cache"


def serve(port):
    root = code_root()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    # 让 .env 和知识库索引缓存都落在可持久的位置，而不是 PyInstaller 的临时解包目录
    os.environ.setdefault("GALGAME_ENV", str(env_file()))
    os.environ.setdefault("GALGAME_IMA_CACHE", str(cache_dir()))
    os.environ["PORT"] = str(port)
    os.environ.setdefault("HOST", "127.0.0.1")
    os.environ["GALGAME_OPEN"] = "0"      # 由启动器统一负责开浏览器

    from server.server import main as server_main
    return server_main()


def selftest(port):
    """自检：把关键路径和资源都验一遍，出问题时用户把这份报告发出来即可"""
    import platform
    ok = True
    lines = []

    def check(label, good, detail=""):
        nonlocal ok
        if not good:
            ok = False
        lines.append(f"  [{'OK' if good else '!!'}] {label}" + (f"  {detail}" if detail else ""))

    lines.append(f"{APP_TITLE} · 自检报告")
    lines.append(f"  时间       {time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"  打包运行   {'是（自带解释器）' if FROZEN else '否（直接用 python 跑）'}")
    lines.append(f"  Python     {platform.python_version()} / {platform.machine()}")
    lines.append(f"  系统       {platform.platform()}")
    lines.append("")

    lines.append("路径：")
    try:
        root = code_root()
        lines.append(f"  代码根目录 {root}")
    except SystemExit:
        root = None
    lines.append(f"  资源目录   {resource_dir()}")
    lines.append(f"  程序目录   {install_dir()}")
    lines.append(f"  配置文件   {env_file()}" + ("" if env_file().exists() else "（还不存在，正常）"))
    lines.append(f"  日志目录   {data_dir()}")
    lines.append(f"  索引缓存   {cache_dir()}")
    lines.append("")

    lines.append("资源：")
    if root:
        web = resource_dir() / "web" if FROZEN else root / "web"
        corpus = resource_dir() / "corpus" if FROZEN else root / "corpus"
        persona = (resource_dir() / "agent" / "persona.md") if FROZEN else (root / "agent" / "persona.md")
        check("前端页面 web/index.html", (web / "index.html").is_file(), str(web))
        try:
            n_png = len(list((web / "assets" / "whale-girl").glob("*.png")))
        except OSError:
            n_png = 0
        check("鲸鱼娘立绘（15 张）", n_png >= 15, f"实际 {n_png} 张")
        try:
            n_corpus = len([p for p in corpus.rglob("*") if p.is_file()]) if corpus.is_dir() else 0
        except OSError:
            n_corpus = 0
        check("内置教材语料 corpus/", n_corpus > 0, f"{n_corpus} 个文件")
        check("鲸鱼娘人设 persona.md", persona.is_file(), str(persona))
    else:
        check("代码目录", False, "找不到 server/server.py")
    icon = find_icon()
    check("图标文件", icon is not None, str(icon) if icon else "缺失")
    lines.append("")

    lines.append("模块导入：")
    try:
        if root and str(root) not in sys.path:
            sys.path.insert(0, str(root))
    except Exception:
        pass
    for mod in ("engine.game", "engine.battle", "agent.llm", "agent.gm", "agent.retriever",
                "agent.textract", "agent.pdfbytes", "agent.visionread", "agent.ima_index",
                "server.server"):
        try:
            __import__(mod)
            check(mod, True)
        except Exception as e:
            check(mod, False, f"{type(e).__name__}: {e}")
    lines.append("")

    # 扫描版 PDF 的读法：这条必须单独报，因为它最容易「看起来在、其实不在」——
    # 页面渲染器是第三方库，打包时不一定带得进去。没带进去时靠纯标准库的兜底，
    # 用户至少要知道当前是哪条路、能不能用。
    lines.append("读扫描版 PDF：")
    try:
        # 先确保 .env 真被读进来了，再判断 —— 否则「配置文件找到了」和
        # 「配置生效了」会不一致，自检就会报出误导性的「未配置」。
        # 路径要**显式传**：server.env 默认按模块位置推算，打包后会落到 _internal 下。
        try:
            os.environ.setdefault("GALGAME_ENV", str(env_file()))
            from server.env import load_env
            load_env(str(env_file()))
        except Exception:
            pass
        from agent import visionread
        st = visionread.status()
        check("取页面图（%s）" % st["rendererKind"], st["renderer"],
              "有 pypdfium2 就真渲染页面；没有就从 PDF 里抠嵌入的页面图（纯标准库）")
        if st["configured"]:
            check("视觉模型已配置", st["ready"], f"{st['base']} / {st['model']}")
        else:
            check("视觉模型未配置", True,
                  "扫描件会读不了。配 GALGAME_VISION_BASE / GALGAME_VISION_MODEL 即可，"
                  "见 README「扫描版 PDF」")
    except Exception as e:
        check("visionread", False, f"{type(e).__name__}: {e}")
    lines.append("")

    lines.append("端口：")
    running, h = find_running(port)
    if running:
        lines.append(f"  [--] 端口 {port}~{port + 39} 上已有一个实例在跑（{running}），"
                     f"demo={'是' if h.get('demo') else '否'}")
    else:
        check(f"端口 {port} 可用", port_free(port))
    lines.append("")

    lines.append("结论：" + ("一切正常，可以正常使用。" if ok else "**有问题** —— 把这份报告整段发出来即可定位。"))
    report = "\n".join(lines)

    print(report)
    try:
        out = data_dir() / "selftest.txt"
        out.write_text(report, encoding="utf-8")
        print(f"\n（这份报告也已保存到：{out}）")
    except OSError:
        pass
    return 0 if ok else 1


# ══════════ 主流程 ══════════

def build_parser():
    p = argparse.ArgumentParser(add_help=True, description=APP_TITLE)
    p.add_argument("--port", type=int, default=int(os.environ.get("GALGAME_PORT") or DEFAULT_PORT))
    p.add_argument("--no-browser", action="store_true")
    p.add_argument("--no-shortcut", action="store_true")
    p.add_argument("--console", action="store_true", help="在当前窗口里跑服务（排查用）")
    p.add_argument("--selftest", action="store_true", help="自检：检查路径、资源、模块（排查用）")
    p.add_argument("--stop", action="store_true", help="停止正在运行的学术galgame")
    p.add_argument("--shortcut", action="store_true", help="只（重新）创建桌面快捷方式")
    p.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    return p


def main():
    opts = build_parser().parse_args()

    if opts.serve:
        return serve(opts.port)

    if opts.selftest:
        attach_console()
        return selftest(opts.port)

    if opts.shortcut:
        attach_console()
        lnk, msg = make_shortcut(force=True)
        if lnk:
            log_to(f"桌面快捷方式已就绪：{lnk}")
            return 0
        log_to(f"创建桌面快捷方式失败：{msg}")
        return 1

    if opts.console:
        attach_console()
        log_to(f"{APP_TITLE} · 排查模式")
        log_to(f"代码目录：{resource_dir()}")
        log_to(f"配置文件：{env_file()}")
        log_to(f"日志目录：{data_dir()}")
        log_to("")
        return serve(opts.port)

    if opts.stop:
        attach_console()          # 让 停止.bat 能看到结果
        port, _ = find_running(opts.port)
        if port is None:
            log_to("学术galgame 现在没有在运行。")
            return 0
        ok, msg = stop_running(port)
        log_to(msg)
        return 0 if ok else 1

    # 已经在跑？直接开浏览器，不重复启动
    port, h = find_running(opts.port)
    if port is not None:
        url = f"http://127.0.0.1:{port}/" + ("#settings" if h.get("demo") else "")
        log_to(f"已经在运行：{url}")
        if not opts.no_browser:
            open_browser(url)
        return 0

    port = pick_port(opts.port)
    log_path = data_dir() / "server.log"

    env = os.environ.copy()
    env["GALGAME_ENV"] = str(env_file())
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
        env.pop(k, None)          # 本机回环不该走代理

    if FROZEN:
        cmd = [str(Path(sys.executable).resolve()), "--serve", "--port", str(port)]
    else:
        cmd = [sys.executable, str(Path(__file__).resolve()), "--serve", "--port", str(port)]

    log_to(f"启动服务：端口 {port}")
    log_to(f"日志文件：{log_path}")

    flags = (CREATE_NO_WINDOW | DETACHED_PROCESS) if IS_WINDOWS else 0
    # 再要一个「脱离 job object」：有些宿主（终端、某些启动器、受限运行环境）
    # 会把子进程放进 job，job 一关就把它一起收走 —— 表现就是「服务起来了又秒退」。
    # 不在 job 里时这个标志会被系统忽略；万一当前 job 不允许脱离，就退回不带它。
    breakaway = flags | CREATE_BREAKAWAY_FROM_JOB if IS_WINDOWS else 0
    try:
        log = open(log_path, "a", encoding="utf-8", errors="replace")
        log.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} 端口 {port} =====\n")
        log.flush()
        try:
            proc = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                    cwd=str(install_dir()), creationflags=breakaway, close_fds=True)
        except OSError:
            proc = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                    cwd=str(install_dir()), creationflags=flags, close_fds=True)
    except Exception as e:
        alert(APP_NAME, f"启动失败：\n{e}")
        return 1

    h = None
    deadline = time.time() + READY_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            tail = ""
            try:
                tail = log_path.read_text(encoding="utf-8", errors="replace")[-900:]
            except OSError:
                pass
            alert(APP_NAME, f"服务启动后立刻退出了（代码 {proc.returncode}）。\n\n最后几行日志：\n{tail}")
            return 1
        h = health(port)
        if h:
            break
        time.sleep(0.4)

    if not h:
        alert(APP_NAME, f"等了 {READY_TIMEOUT} 秒服务还没起来。\n\n日志：{log_path}")
        return 1

    url = f"http://127.0.0.1:{port}/"
    if h.get("demo"):
        url += "#settings"
        log_to("还没填大模型 Key —— 已为你打开「⚙ 设置」页，填完就是真的 AI 老师。")

    if not opts.no_shortcut:
        lnk, msg = make_shortcut()
        if lnk:
            log_to(f"桌面快捷方式：{msg}")

    log_to(f"已就绪：{url}")
    if not opts.no_browser:
        open_browser(url)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:  # 兜底：绝不把 traceback 甩给普通用户
        import traceback
        detail = traceback.format_exc()
        try:
            (data_dir() / "launcher-error.log").write_text(detail, encoding="utf-8")
        except OSError:
            pass
        alert(APP_NAME, f"启动器出错了：\n{exc}\n\n详细信息：{data_dir() / 'launcher-error.log'}")
        sys.exit(1)
