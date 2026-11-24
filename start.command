#!/bin/bash
set -e

cd "$(dirname "$0")"

# 双击 .command 时默认 PATH 可能不包含 Homebrew / nvm / fnm / Volta
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.fnm/current/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[错误] 未找到 Node.js，请先安装：https://nodejs.org/ 或 brew install node"
  echo ""
  read -r -p "按回车键退出…"
  exit 1
fi

PORT="${PORT:-7788}"

# 稍等服务监听后再自动打开默认浏览器
(sleep 1 && open "http://localhost:${PORT}") >/dev/null 2>&1 &

node server.js "$@"
