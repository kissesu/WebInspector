#!/bin/bash

###############################################################################
# Web Inspector Bridge Server 启动脚本
# 职责：确保 Bridge Server 正常启动（MCP Server 由 Claude Code 自动管理）
# 用法：./start-bridge.sh
###############################################################################

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_SCRIPT="$SCRIPT_DIR/server.js"
SERVER_LOG="$SCRIPT_DIR/server.log"
SERVER_PID_FILE="$SCRIPT_DIR/bridge.pid"

# ============================================
# 检查 Server 是否运行
# ============================================
check_server_running() {
  if [ -f "$SERVER_PID_FILE" ]; then
    local pid=$(cat "$SERVER_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    else
      # PID 文件过期，清理
      rm -f "$SERVER_PID_FILE"
    fi
  fi
  return 1
}

# ============================================
# 检查端口是否被占用
# ============================================
check_port_in_use() {
  local port=$1
  lsof -i ":$port" -sTCP:LISTEN -t >/dev/null 2>&1
}

# ============================================
# 启动 Server
# ============================================
start_server() {
  # 检查是否已运行
  if check_server_running; then
    echo "Bridge Server running (PID: $(cat "$SERVER_PID_FILE"))"
    return 0
  fi

  # 检查端口冲突
  if check_port_in_use 51765 || check_port_in_use 51766; then
    pkill -f "node.*server\.js" 2>/dev/null || true
    sleep 1
  fi

  # 后台启动 Server
  cd "$SCRIPT_DIR"
  nohup node "$SERVER_SCRIPT" > "$SERVER_LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$SERVER_PID_FILE"

  # 等待 Server 就绪（最多等待3秒）
  local count=0
  while [ $count -lt 6 ]; do
    if check_port_in_use 51765 && check_port_in_use 51766; then
      echo "Bridge Server started (PID: $pid)"
      return 0
    fi
    sleep 0.5
    count=$((count + 1))
  done

  echo "Bridge Server start timeout"
  return 1
}

# ============================================
# 主逻辑
# ============================================
start_server
