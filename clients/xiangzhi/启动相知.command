#!/bin/bash
# Finder does not inherit a Terminal shell's Homebrew PATH.
cd -- "$(dirname -- "$0")" || exit 1
for candidate in "${XIANZHI_NODE_BIN:-}" /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' >/dev/null 2>&1; then
    "$candidate" scripts/launcher.mjs start
    result=$?
    if [ "$result" -ne 0 ]; then read -r -p "按回车关闭此窗口…"; fi
    exit "$result"
  fi
done
echo "未找到 Node.js 22.13 或更新版本。请先安装 Node.js LTS，或通过 Homebrew 运行 brew install node@22，然后再次双击。"
read -r -p "按回车关闭此窗口…"
exit 1
