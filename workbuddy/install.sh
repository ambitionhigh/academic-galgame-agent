#!/usr/bin/env bash
# 工作伙伴（WorkBuddy）技能安装脚本 — macOS / Linux
#
# 把本目录下 skills/ 里的技能复制到 WorkBuddy 的技能目录：
#   ~/.workbuddy/skills/<技能名>/
#
# 用法：
#   ./install.sh                       # 安装到默认位置
#   ./install.sh /path/to/skills       # 安装到自定义位置
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DST="${1:-$HOME/.workbuddy/skills}"
SRC="$HERE/skills"

[ -d "$SRC" ] || { echo "未找到技能目录：$SRC" >&2; exit 1; }
mkdir -p "$DST"

count=0
for s in "$SRC"/*/; do
  [ -d "$s" ] || continue
  name="$(basename "$s")"
  rm -rf "$DST/$name"
  cp -R "$s" "$DST/$name"
  echo "  ✓ $name  →  $DST/$name"
  count=$((count + 1))
done

echo ""
echo "已安装 $count 个技能到：$DST"
echo ""
echo "接下来："
echo "  1. 打开 WorkBuddy，在对话里说：「开始教学，我想学纳什均衡」"
echo "  2. 或用 @技能名 手动触发：@academic-galgame 看看我的进度"
echo ""
echo "卸载：删除 $DST 下的技能目录即可。"
echo "存档位于：$HOME/.workbuddy/academic-galgame/save.json"
