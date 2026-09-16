# download/ · 成品下载

这里放**打包好的、点击即下**的发行包 —— 给不想碰命令行的同学。

## 下载

| 文件 | 大小 | 是什么 |
|---|---|---|
| [`academic-galgame-windows.zip`](./academic-galgame-windows.zip) | 10.8 MB | **Windows 桌面版**，解压后双击 `学术galgame.exe` 即用 |

## 用起来只要三步

1. 下载后**解压**（右键 → 全部解压缩）
2. 双击解压出来的 **`学术galgame.exe`**
3. 浏览器自动打开 → 点右上角 **「⚙ 设置」**，填上你自己的大模型 API Key

**不需要装 Python，也不需要装 Node** —— 运行时和游戏代码都打包在里面了。

## 包里有什么

```
学术galgame/
├── 学术galgame.exe              ← 双击这个
├── _internal/                   ← 运行时（不用管）
├── 鲸鱼娘.ico                   ← 桌面快捷方式的图标
├── 使用说明.txt                 ← 从「第一次填什么」到「怎么卸载」
├── 自检.bat                     ← 出问题先双击这个
├── 排查模式.bat                 ← 看运行日志
├── 停止.bat                     ← 彻底关掉后台服务
└── 重新创建桌面快捷方式.bat
```

## 这个包安全吗

- 全部代码都在本仓库里，可以自己对着看 —— 它就是 [`python/`](../python/) 目录
- 服务只监听 `127.0.0.1`，只有本机能访问
- **包里不含任何 API Key**：谁用谁填自己的，存在各自浏览器里
- 纯绿色版：删掉文件夹就卸载干净，不写注册表

## 为什么这个 zip 会进 Git 仓库

因为它只有一个，而且换版本时**覆盖同名文件**即可，历史不会无限膨胀。
如果你更希望把它放到 GitHub Releases，见下面。

### 换成 GitHub Release（可选）

`desktop/release/academic-galgame-windows.zip` 每次构建都会重新生成。
想改成发布到 Releases 的话：

1. 打开 <https://github.com/ambitionhigh/academic-galgame-agent/releases/new>
2. **Choose a tag** 里填 `v1.0.0` → 点 **Create new tag**
3. 标题填 `学术galgame v1.0.0 · Windows 桌面版`
4. 把 `desktop/release/academic-galgame-windows.zip` 拖进 **Attach binaries** 框
5. 点 **Publish release**

之后就能把 Release 页面的链接发给别人，同时把本目录的 zip 删掉。

## 自己重新构建

见 [`desktop/README.md`](../desktop/README.md)。
