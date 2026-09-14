#!/usr/bin/env bash
# sync-engine.sh —— 把主项目的引擎同步进 WorkBuddy 技能包（macOS / Linux）
#
# 背景：WorkBuddy 技能必须自包含，所以 skills/academic-galgame/scripts/engine/ 是
#       从 src/engine/ 同步出来的副本。改了主项目引擎后务必跑一次本脚本，避免两边漂移。
#
# 用法：
#   ./sync-engine.sh           # 同步
#   ./sync-engine.sh --check   # 只校验：不一致则退出码 1（适合 CI）
set -euo pipefail

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
SRC="$REPO/src/engine"
DST="$HERE/skills/academic-galgame/scripts/engine"

# 技能内嵌引擎需要的最小集合（不含 storage.js / session.js —— 那是服务端用的）
FILES=(config.js game.js battle.js)

[ -d "$SRC" ] || { echo "未找到源目录：$SRC" >&2; exit 1; }
mkdir -p "$DST"

hash_of() { [ -f "$1" ] && shasum -a 256 "$1" | awk '{print $1}' || echo ""; }

echo ""
echo "  引擎同步检查"
echo "    源  : $SRC"
echo "    目标: $DST"
echo ""

same=(); diff=(); missing=()
for f in "${FILES[@]}"; do
  s="$SRC/$f"; d="$DST/$f"
  [ -f "$s" ] || { echo "源文件缺失：$s" >&2; exit 1; }
  hs="$(hash_of "$s")"; hd="$(hash_of "$d")"
  if [ -z "$hd" ]; then missing+=("$f")
  elif [ "$hs" = "$hd" ]; then same+=("$f")
  else diff+=("$f"); fi
done

for f in "${same[@]:-}";    do [ -n "$f" ] && echo "    = $f  一致"; done
for f in "${diff[@]:-}";    do [ -n "$f" ] && echo "    ~ $f  内容不同"; done
for f in "${missing[@]:-}"; do [ -n "$f" ] && echo "    + $f  目标缺失"; done

if [ "$CHECK" = "1" ]; then
  echo ""
  if [ "$(( ${#diff[@]} + ${#missing[@]} ))" -gt 0 ]; then
    echo "  ✗ 技能包引擎与主项目不一致。请运行： ./sync-engine.sh"
    exit 1
  fi
  echo "  ✓ 技能包引擎与主项目完全一致"
  exit 0
fi

if [ "$(( ${#diff[@]} + ${#missing[@]} ))" -eq 0 ]; then
  echo ""
  echo "  ✓ 已是最新，无需同步"
  exit 0
fi

echo ""
for f in "${diff[@]:-}" "${missing[@]:-}"; do
  [ -n "$f" ] || continue
  cp "$SRC/$f" "$DST/$f"
  echo "    → 已同步 $f"
done

bad=0
for f in "${FILES[@]}"; do
  [ "$(hash_of "$SRC/$f")" = "$(hash_of "$DST/$f")" ] || bad=$((bad + 1))
done
echo ""
[ "$bad" -gt 0 ] && { echo "  ✗ 同步后仍不一致（$bad 个）"; exit 1; }
echo "  ✓ 同步完成，已校验一致"
