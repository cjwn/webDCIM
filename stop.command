#!/bin/bash
cd "$(dirname "$0")"

PID_FILE="cache/server.pid"
if [ ! -f "$PID_FILE" ]; then
  echo "未找到 $PID_FILE —— 服务可能没有在运行。"
  sleep 2
  exit 0
fi

PID="$(cat "$PID_FILE" | tr -d '[:space:]')"
if [ -n "$PID" ] && kill -0 "$PID" >/dev/null 2>&1; then
  echo "正在停止照片库服务 (PID $PID)…"
  kill "$PID" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "$PID" >/dev/null 2>&1; then
    kill -9 "$PID" >/dev/null 2>&1 || true
  fi
  echo "已停止。"
else
  echo "进程 (PID ${PID:-未知}) 已不在运行。"
fi

rm -f "$PID_FILE"
sleep 1
