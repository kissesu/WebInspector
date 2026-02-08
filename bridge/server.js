/**
 * @file Web Inspector Bridge - WebSocket 桥接服务器
 * @description 接收浏览器端元素数据，格式化后输出到 stdout 或剪贴板
 * @author Atlas.oi
 * @date 2026-02-08
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const WebSocket = require('ws');

// ============================================
// 常量配置
// ============================================
const PID_FILE = path.join(__dirname, 'bridge.pid');
const DEFAULT_PORT = 51765;
const SUBSCRIBER_PORT = 51766;  // CLI 订阅端口

const runtimeOptions = {
  port: DEFAULT_PORT
};

// 订阅者管理（CLI 客户端）
const subscribers = new Map();
// clientId → { ws, projectPath, projectName, tty, pid, lastHeartbeat }

// ============================================
// PID 文件管理
// ============================================

/**
 * 清理 PID 文件
 */
function cleanupPidFile() {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch (error) {
    process.stderr.write(`[Bridge] PID 文件清理失败: ${error.message}\n`);
  }
}

/**
 * 启动前端口清理 - PID 文件锁（TD16）
 *
 * 业务逻辑：
 * 1. 读取 bridge.pid 文件，获取旧进程 PID
 * 2. 使用 process.kill(pid, 0) 检测进程是否存在
 * 3. 如果存在，使用 SIGTERM 优雅终止
 * 4. 删除旧 PID 文件，写入当前 PID
 *
 * @param {number} port - 目标端口号（暂未使用，预留扩展）
 */
function cleanupPort(port) {
  try {
    if (fs.existsSync(PID_FILE)) {
      const content = fs.readFileSync(PID_FILE, 'utf8').trim();
      const oldPid = Number.parseInt(content, 10);

      if (Number.isFinite(oldPid) && oldPid > 0 && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          process.kill(oldPid, 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') {
            process.stderr.write(`[Bridge] 终止旧进程失败: ${error.message}\n`);
          }
        }
      }

      fs.unlinkSync(PID_FILE);
    }
  } catch (error) {
    process.stderr.write(`[Bridge] 读取 PID 文件失败: ${error.message}\n`);
  }

  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch (error) {
    process.stderr.write(`[Bridge] 写入 PID 文件失败: ${error.message}\n`);
  }
}

// ============================================
// CLI 参数解析
// ============================================

/**
 * 解析命令行参数
 *
 * @param {string[]} argv - process.argv
 * @returns {{ port: number }}
 */
function parseArgs(argv) {
  const result = { port: DEFAULT_PORT };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--port' && i + 1 < argv.length) {
      const value = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(value) && value > 0) {
        result.port = value;
      }
      i += 1;
      continue;
    }

    if (arg.startsWith('--port=')) {
      const value = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isFinite(value) && value > 0) {
        result.port = value;
      }
    }
  }

  return result;
}

// ============================================
// WebSocket 服务器创建（TD13: Promise + 事件）
// ============================================

/**
 * 尝试在指定端口创建 WebSocket 服务器（返回 Promise）
 *
 * 业务逻辑：
 * - 必须使用 Promise + 事件监听（TD13 Codex Review 改进）
 * - 不可使用同步 try-catch（WebSocket.Server 不同步抛出 EADDRINUSE）
 *
 * @param {number} port - 端口号
 * @returns {Promise<WebSocket.Server>}
 */
function tryPort(port) {
  return new Promise((resolve, reject) => {
    const server = new WebSocket.Server({ port });

    const cleanup = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
    };

    const onListening = () => {
      cleanup();
      resolve(server);
    };

    const onError = (error) => {
      cleanup();
      try {
        server.close();
      } catch (closeError) {
        // 忽略关闭错误
      }
      reject(error);
    };

    server.once('listening', onListening);
    server.once('error', onError);
  });
}

/**
 * 创建 WebSocket 服务器，端口占用时自动 +1 重试（最多 3 次）
 *
 * @param {number} port - 初始端口号
 * @returns {Promise<{ server: WebSocket.Server, port: number }>}
 */
async function createServer(port) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentPort = port + attempt;
    try {
      const server = await tryPort(currentPort);
      console.log(`[Web Inspector Bridge] 监听端口: ${currentPort}`);
      return { server, port: currentPort };
    } catch (error) {
      if (error && error.code === 'EADDRINUSE') {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('端口不可用');
}

// ============================================
// 格式化输出
// ============================================

/**
 * Markdown 表格单元格转义
 *
 * @param {any} text - 单元格内容
 * @returns {string}
 */
function escapeTableCell(text) {
  if (text === null || text === undefined) {
    return '';
  }
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}


// ============================================
// 自动粘贴推送（Push to Ghostty/Claude Code）
// ============================================

/**
 * 将元素数据格式化为粘贴到 Claude Code 的完整消息
 *
 * 业务逻辑：
 * 1. 以 [Web Inspector] 前缀标识来源
 * 2. 包含完整元素信息（标签、选择器、属性、样式、HTML）
 * 3. 对超长文本进行截断保护
 *
 * @param {Object} data - 元素数据对象
 * @returns {string} 格式化后的完整消息文本
 */
function formatElementForPaste(data) {
  const safeData = data || {};
  const tagName = safeData.tagName || '';
  const id = safeData.id || '';
  const className = safeData.className || '';
  const cssSelector = safeData.cssSelector || '';
  const xpath = safeData.xpath || '';
  const rect = safeData.boundingRect || {};
  const width = Number.isFinite(rect.width) ? Math.round(rect.width) : '';
  const height = Number.isFinite(rect.height) ? Math.round(rect.height) : '';
  const attributes = safeData.attributes || {};
  const computedStyles = safeData.computedStyles || safeData.styles || {};
  const outerHTML = safeData.outerHTML || '';

  // 文本内容截断到 200 字符
  let textContent = safeData.textContent || '';
  if (textContent.length > 200) {
    textContent = textContent.slice(0, 200) + '...';
  }

  // HTML 截断到 3000 字符
  let htmlContent = outerHTML;
  if (htmlContent.length > 3000) {
    htmlContent = htmlContent.slice(0, 3000) + '\n<!-- truncated -->';
  }

  // 构建标识标题
  const classLabel = typeof className === 'string'
    ? className.trim().split(/\s+/).filter(Boolean).map(c => `.${c}`).join('')
    : '';
  const title = `${tagName || 'element'}${id ? `#${id}` : ''}${classLabel}`;

  // 属性表
  const attrRows = Object.entries(attributes)
    .map(([k, v]) => `| ${escapeTableCell(k)} | ${escapeTableCell(String(v))} |`)
    .join('\n');

  // 样式表
  const styleRows = Object.entries(computedStyles)
    .map(([k, v]) => `| ${escapeTableCell(k)} | ${escapeTableCell(String(v))} |`)
    .join('\n');

  const lines = [
    `[Web Inspector] ${title}`,
    '',
    `- 标签: ${tagName}`,
    `- ID: ${id}`,
    `- 类名: ${className}`,
    `- 选择器: \`${cssSelector}\``,
    `- XPath: \`${xpath}\``,
    `- 文本: ${textContent}`,
    `- 尺寸: ${width} x ${height}`,
  ];

  if (attrRows) {
    lines.push('', '属性:', '| 属性 | 值 |', '|------|---|', attrRows);
  }

  if (styleRows) {
    lines.push('', '关键样式:', '| 属性 | 值 |', '|------|---|', styleRows);
  }

  if (htmlContent) {
    lines.push('', 'HTML:', '```html', htmlContent, '```');
  }

  return lines.join('\n');
}

/**
 * 自动粘贴消息到 Ghostty 中的 Claude Code（Push 模型核心）
 *
 * 业务逻辑：
 * 1. 检测 Ghostty 是否运行
 * 2. 保存当前剪贴板内容
 * 3. 将格式化消息写入剪贴板
 * 4. 通过 AppleScript System Events 模拟 Cmd+V + Enter
 * 5. 延迟后恢复原始剪贴板
 *
 * 技术验证：System Events 模拟的按键走 macOS HID 事件系统，
 *          Claude Code 的 Ink TUI 将其等同于物理键盘输入处理。
 *
 * @param {string} message - 要粘贴的消息文本
 */
function autoPasteToGhostty(message) {
  try {
    // 第一步：检测 Ghostty 是否运行
    try {
      execSync('pgrep -f "Ghostty.app"', { encoding: 'utf8', timeout: 1000 });
    } catch (_) {
      process.stdout.write('[AutoPaste] WARN: Ghostty 未运行，跳过自动粘贴\n');
      return;
    }

    // 第二步：保存当前剪贴板
    let originalClipboard = '';
    try {
      originalClipboard = execSync('pbpaste', { encoding: 'utf8', timeout: 1000 });
    } catch (_) {
      // 剪贴板为空或读取失败，不影响主流程
    }

    // 第三步：写入消息到剪贴板
    execSync('pbcopy', { input: message, timeout: 1000 });

    // 第四步：AppleScript 激活 Ghostty + 模拟粘贴（不自动提交，用户可追加指令后手动回车）
    const appleScript = [
      'tell application "Ghostty" to activate',
      'delay 0.3',
      'tell application "System Events"',
      '  tell process "Ghostty"',
      '    keystroke "v" using command down',
      '  end tell',
      'end tell',
    ];
    const args = appleScript.map(line => `-e '${line}'`).join(' ');
    execSync(`osascript ${args}`, { encoding: 'utf8', timeout: 5000 });

    process.stdout.write('[AutoPaste] OK: 已粘贴到 Ghostty\n');

    // 第五步：延迟恢复剪贴板（异步，不阻塞）
    setTimeout(() => {
      try {
        execSync('pbcopy', { input: originalClipboard, timeout: 1000 });
      } catch (_) {
        // 恢复失败不影响主流程
      }
    }, 500);
  } catch (error) {
    process.stderr.write(`[AutoPaste] ERR: ${error.message}\n`);
  }
}

// ============================================
// 焦点检测与智能路由
// ============================================

/**
 * 检测当前激活的 Ghostty 窗口的 TTY
 *
 * 业务逻辑：
 * 1. 使用 AppleScript 检测当前前台应用
 * 2. 检查是否为 Ghostty
 * 3. 获取激活窗口的标题（可能包含项目路径）
 * 4. 500ms 超时保护
 *
 * @returns {string|null} 窗口标题（可能包含路径）或 null
 */
function detectActiveTTY() {
  try {
    // AppleScript 脚本分行，使用多个 -e 参数避免语法错误
    const scriptLines = [
      'tell application "System Events"',
      '  set frontApp to name of first application process whose frontmost is true',
      '  if frontApp is "Ghostty" then',
      '    tell process "Ghostty"',
      '      set windowTitle to name of front window',
      '      return windowTitle',
      '    end tell',
      '  end if',
      'end tell'
    ];

    // 构建 osascript 命令，每行一个 -e 参数
    const args = scriptLines.map(line => `-e '${line}'`).join(' ');
    const result = execSync(`osascript ${args}`, {
      encoding: 'utf8',
      timeout: 500
    }).trim();

    return result || null;
  } catch (error) {
    // 检测失败不阻塞，返回 null 降级到其他策略
    return null;
  }
}

/**
 * 精确选择目标 CLI（无兜底策略）
 *
 * 路由规则：
 * 1. 单客户端 → 直接路由（零歧义，最常见的 MCP 场景）
 * 2. 多客户端 → 系统焦点检测（匹配 Ghostty 窗口标题与项目路径）
 * 3. 多客户端 → 唯一活跃心跳检测（3 秒内仅一个活跃时使用）
 * 4. 无法确定 → 返回 null，由调用方记录错误（拒绝盲选）
 *
 * @returns {Object|null} 目标 CLI 客户端对象或 null
 */
function selectTargetClient() {
  if (subscribers.size === 0) {
    return null;
  }

  // 单客户端：直接路由（MCP 架构下最常见的场景）
  if (subscribers.size === 1) {
    const client = subscribers.values().next().value;
    process.stdout.write(`[Router] -> ${client.projectName}\n`);
    return client;
  }

  // 多客户端场景：精确匹配，拒绝盲选

  // 策略 1：系统焦点检测
  const activeWindow = detectActiveTTY();
  if (activeWindow) {
    for (const client of subscribers.values()) {
      if (client.projectPath && activeWindow.includes(client.projectPath)) {
        process.stdout.write(`[Router] [焦点] ${client.projectName}\n`);
        return client;
      }
      if (client.tty && activeWindow.includes(client.tty)) {
        process.stdout.write(`[Router] [焦点] ${client.projectName} (${client.tty})\n`);
        return client;
      }
    }
  }

  // 策略 2：唯一活跃心跳（3 秒内仅一个活跃才可信）
  const now = Date.now();
  const recentClients = Array.from(subscribers.values())
    .filter(c => now - c.lastHeartbeat < 3000);

  if (recentClients.length === 1) {
    process.stdout.write(`[Router] [心跳] ${recentClients[0].projectName}\n`);
    return recentClients[0];
  }

  // 无法确定目标 — 明确拒绝，不做兜底
  if (recentClients.length > 1) {
    const names = recentClients.map(c => c.projectName).join(', ');
    process.stdout.write(`[Router] [冲突] ${recentClients.length} 个活跃客户端 (${names})，无法确定目标\n`);
  } else {
    const staleNames = Array.from(subscribers.values()).map(c => c.projectName).join(', ');
    process.stdout.write(`[Router] [超时] 无活跃客户端 (已注册: ${staleNames})，心跳超时\n`);
  }

  return null;
}

// ============================================
// WebSocket 连接处理
// ============================================

/**
 * 处理订阅者（CLI）连接
 *
 * 业务逻辑：
 * 1. 接收 register 消息，注册 CLI 客户端
 * 2. 接收 heartbeat 消息，更新活跃时间
 * 3. 连接断开时清理订阅者
 *
 * @param {WebSocket} ws - WebSocket 连接对象
 */
function handleSubscriberConnection(ws) {
  let clientId = null;

  ws.on('message', (message) => {
    let payload;
    try {
      const raw = Buffer.isBuffer(message) ? message.toString('utf8') : String(message);
      payload = JSON.parse(raw);
    } catch (error) {
      process.stderr.write(`[Bridge] 订阅者消息解析失败: ${error.message}\n`);
      return;
    }

    // 处理注册消息
    if (payload.type === 'register') {
      clientId = payload.clientId;
      subscribers.set(clientId, {
        ws,
        projectPath: payload.projectPath || '',
        projectName: payload.projectName || 'Unknown',
        tty: payload.tty || 'unknown',
        pid: payload.pid || 0,
        lastHeartbeat: Date.now()
      });
      process.stdout.write(`[Bridge] ✅ CLI 注册: ${payload.projectName} (${payload.tty})\n`);
    }

    // 处理心跳消息
    if (payload.type === 'heartbeat') {
      const client = subscribers.get(payload.clientId);
      if (client) {
        client.lastHeartbeat = Date.now();
      }
    }
  });

  ws.on('close', () => {
    if (clientId && subscribers.has(clientId)) {
      const client = subscribers.get(clientId);
      process.stdout.write(`[Bridge] ❌ CLI 断开: ${client.projectName}\n`);
      subscribers.delete(clientId);
    }
  });

  ws.on('error', (error) => {
    process.stderr.write(`[Bridge] 订阅者连接错误: ${error.message}\n`);
  });
}

/**
 * 处理浏览器连接（接收元素数据）
 *
 * 业务逻辑：
 * 1. 接收消息并解析 JSON
 * 2. 忽略 ping 消息
 * 3. 使用智能路由选择目标 CLI
 * 4. 转发消息到目标 CLI，或输出到 stdout（兼容旧版）
 *
 * @param {WebSocket} ws - WebSocket 连接对象
 */
function handleBrowserConnection(ws) {
  ws.on('message', (message) => {
    let payload;
    try {
      const raw = Buffer.isBuffer(message) ? message.toString('utf8') : String(message);
      payload = JSON.parse(raw);
    } catch (error) {
      process.stderr.write(`[Bridge] 浏览器消息解析失败: ${error.message}\n`);
      return;
    }

    if (payload && payload.type === 'ping') {
      return;
    }

    const data = payload && payload.data ? payload.data : payload;

    // ============================================
    // 主通道：自动粘贴到 Ghostty/Claude Code（Push 模型）
    // ============================================
    const pasteMessage = formatElementForPaste(data);
    autoPasteToGhostty(pasteMessage);

    // ============================================
    // 补充通道：转发到 MCP Server 订阅者（Pull 模型备用）
    // ============================================
    const target = selectTargetClient();
    if (target && target.ws && target.ws.readyState === 1) {
      target.ws.send(JSON.stringify({
        type: 'element',
        data: data
      }));
      process.stdout.write(`[Bridge] MCP -> ${target.projectName}\n`);
    }
  });

  ws.on('error', (error) => {
    process.stderr.write(`[Bridge] 浏览器连接错误: ${error.message}\n`);
  });
}

// ============================================
// 优雅退出
// ============================================

/**
 * 设置优雅退出处理（支持多服务器）
 *
 * 业务逻辑：
 * 1. 监听 SIGINT/SIGTERM 信号
 * 2. 关闭所有 WebSocket 连接（浏览器 + 订阅者）
 * 3. 关闭所有服务器
 * 4. 清理 PID 文件（TD16）
 * 5. 退出进程
 *
 * @param {WebSocket.Server} browserServer - 浏览器服务器实例
 * @param {WebSocket.Server} subscriberServer - 订阅者服务器实例
 */
function setupGracefulShutdown(browserServer, subscriberServer) {
  let isShuttingDown = false;

  const shutdown = () => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    process.stdout.write('[Bridge] 正在关闭...\n');

    // 关闭所有浏览器连接
    if (browserServer && browserServer.clients) {
      browserServer.clients.forEach((client) => {
        try {
          client.close();
        } catch (error) {
          // 忽略关闭错误
        }
      });
    }

    // 关闭所有订阅者连接
    if (subscriberServer && subscriberServer.clients) {
      subscriberServer.clients.forEach((client) => {
        try {
          client.close();
        } catch (error) {
          // 忽略关闭错误
        }
      });
    }

    // 清理订阅者列表
    subscribers.clear();

    const exit = () => {
      cleanupPidFile();
      process.stdout.write('[Bridge] 已停止\n');
      process.exit(0);
    };

    let closedCount = 0;
    const onServerClosed = () => {
      closedCount += 1;
      if (closedCount === 2) {
        exit();
      }
    };

    if (browserServer) {
      browserServer.close(onServerClosed);
    } else {
      closedCount += 1;
    }

    if (subscriberServer) {
      subscriberServer.close(onServerClosed);
    } else {
      closedCount += 1;
    }

    // 超时保护
    setTimeout(exit, 2000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ============================================
// 主入口
// ============================================

/**
 * 主函数（重构：双服务器架构）
 *
 * 流程：
 * 1. 解析 CLI 参数
 * 2. 清理端口（PID 文件锁）
 * 3. 创建浏览器 WebSocket 服务器（51765）
 * 4. 创建订阅者 WebSocket 服务器（51766）
 * 5. 注册连接处理
 * 6. 设置优雅退出
 */
async function main() {
  const options = parseArgs(process.argv);
  runtimeOptions.port = options.port;

  cleanupPort(options.port);

  // 创建浏览器服务器（接收元素数据）
  const { server: browserServer, port: browserPort } = await createServer(options.port);
  runtimeOptions.port = browserPort;
  process.stdout.write(`[Bridge] 📡 浏览器端口: ${browserPort}\n`);

  // 创建订阅者服务器（CLI 连接）
  let subscriberServer;
  try {
    subscriberServer = new WebSocket.Server({ port: SUBSCRIBER_PORT });
    process.stdout.write(`[Bridge] 🔗 订阅端口: ${SUBSCRIBER_PORT}\n`);
  } catch (error) {
    process.stderr.write(`[Bridge] 订阅服务器启动失败: ${error.message}\n`);
    throw error;
  }

  // 注册连接处理
  browserServer.on('connection', (ws) => {
    process.stdout.write('[Bridge] 浏览器已连接\n');
    handleBrowserConnection(ws);
  });

  subscriberServer.on('connection', (ws) => {
    process.stdout.write('[Bridge] CLI 客户端连接中...\n');
    handleSubscriberConnection(ws);
  });

  // 设置优雅退出
  setupGracefulShutdown(browserServer, subscriberServer);

  process.stdout.write('[Bridge] ✅ 服务启动完成\n');
}

// ============================================
// 模块导出与启动
// ============================================

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[Web Inspector Bridge] 启动失败: ${error.message}\n`);
    cleanupPidFile();
    process.exit(1);
  });
}

module.exports = { main };
