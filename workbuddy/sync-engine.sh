#!/usr/bin/env bash
# sync-engine.sh —— 把主项目的引擎与立绘同步进 WorkBuddy 技能包（macOS / Linux）
#
# 用法：
#   ./sync-engine.sh           # 同步
#   ./sync-engine.sh --check   # 只校验：不一致则退出码 1（适合 CI）
set -euo pipefail

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
SKILL="$HERE/skills/academic-galgame"

# 引擎需要的最小集合（storage.js / session.js 是服务端专用，不进技能包）
ENGINE_FILES=(config.js game.js battle.js)
ENGINE_SRC="$REPO/src/engine"
ENGINE_DST="$SKILL/scripts/engine"
ASSET_SRC="$REPO/src/web/assets/whale-girl"
ASSET_DST="$SKILL/assets/whale-girl"

hash_of() { [ -f "$1" ] && shasum -a 256 "$1" | awk '{print $1}' || echo ""; }

total_diff=0
total_missing=0

echo ""
echo "  技能包同步检查"
echo "    主项目: $REPO"
echo "    技能包: $SKILL"
echo ""

# ── 组 1：引擎 ──
[ -d "$ENGINE_SRC" ] || { echo "未找到源目录（引擎）：$ENGINE_SRC" >&2; exit 1; }
e_same=0; e_diff=(); e_missing=()
for f in "${ENGINE_FILES[@]}"; do
  hs="$(hash_of "$ENGINE_SRC/$f")"; hd="$(hash_of "$ENGINE_DST/$f")"
  [ -n "$hs" ] || continue
  if [ -z "$hd" ]; then e_missing+=("$f")
  elif [ "$hs" = "$hd" ]; then e_same=$((e_same + 1))
  else e_diff+=("$f"); fi
done
total_diff=$((total_diff + ${#e_diff[@]}))
total_missing=$((total_missing + ${#e_missing[@]}))
echo "    [引擎] 共 ${#ENGINE_FILES[@]} 个，一致 $e_same  → $([ "$(( ${#e_diff[@]} + ${#e_missing[@]} ))" -eq 0 ] && echo '✓ 一致' || echo "需同步 $(( ${#e_diff[@]} + ${#e_missing[@]} )) 个")"
for f in "${e_diff[@]:-}";    do [ -n "$f" ] && echo "        ~ $f  内容不同"; done
for f in "${e_missing[@]:-}"; do [ -n "$f" ] && echo "        + $f  目标缺失"; done

# ── 组 2：立绘 ──
[ -d "$ASSET_SRC" ] || { echo "未找到源目录（立绘）：$ASSET_SRC" >&2; exit 1; }
a_total=0; a_same=0; a_diff=(); a_missing=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  a_total=$((a_total + 1))
  hs="$(hash_of "$ASSET_SRC/$f")"; hd="$(hash_of "$ASSET_DST/$f")"
  if [ -z "$hd" ]; then a_missing+=("$f")
  elif [ "$hs" = "$hd" ]; then a_same=$((a_same + 1))
  else a_diff+=("$f"); fi
done < <(cd "$ASSET_SRC" && ls -1)
total_diff=$((total_diff + ${#a_diff[@]}))
total_missing=$((total_missing + ${#a_missing[@]}))
echo "    [立绘] 共 $a_total 个，一致 $a_same  → $([ "$(( ${#a_diff[@]} + ${#a_missing[@]} ))" -eq 0 ] && echo '✓ 一致' || echo "需同步 $(( ${#a_diff[@]} + ${#a_missing[@]} )) 个")"
for f in "${a_diff[@]:-}";    do [ -n "$f" ] && echo "        ~ $f  内容不同"; done
for f in "${a_missing[@]:-}"; do [ -n "$f" ] && echo "        + $f  目标缺失"; done

echo ""
if [ "$CHECK" = "1" ]; then
  if [ "$(( total_diff + total_missing ))" -gt 0 ]; then
    echo "  ✗ 技能包与主项目不一致（$(( total_diff + total_missing )) 个文件）。请运行： ./sync-engine.sh"
    exit 1
  fi
  echo "  ✓ 技能包与主项目完全一致"
  exit 0
fi

if [ "$(( total_diff + total_missing ))" -eq 0 ]; then
  echo "  ✓ 已是最新，无需同步"
  exit 0
fi

mkdir -p "$ENGINE_DST" "$ASSET_DST"
for f in "${e_diff[@]:-}" "${e_missing[@]:-}"; do
  [ -n "$f" ] || continue
  cp "$ENGINE_SRC/$f" "$ENGINE_DST/$f"; echo "    → 已同步 [引擎] $f"
done
for f in "${a_diff[@]:-}" "${a_missing[@]:-}"; do
  [ -n "$f" ] || continue
  cp "$ASSET_SRC/$f" "$ASSET_DST/$f"; echo "    → 已同步 [立绘] $f"
done

bad=0
for f in "${ENGINE_FILES[@]}"; do
  [ "$(hash_of "$ENGINE_SRC/$f")" = "$(hash_of "$ENGINE_DST/$f")" ] || bad=$((bad + 1))
done
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ "$(hash_of "$ASSET_SRC/$f")" = "$(hash_of "$ASSET_DST/$f")" ] || bad=$((bad + 1))
done < <(cd "$ASSET_SRC" && ls -1)

echo ""
[ "$bad" -gt 0 ] && { echo "  ✗ 同步后仍不一致（$bad 个）"; exit 1; }
echo "  ✓ 同步完成，已校验一致"
