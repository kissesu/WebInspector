#!/usr/bin/env node

/**
 * @file Web Inspector MCP Server
 * @description MCP 协议服务器，连接 Bridge WebSocket 接收元素数据，
 *              通过 MCP 工具暴露给 Claude Code CLI
 * @author Atlas.oi
 * @date 2026-02-08
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============================================
// ESM __dirname 兼容
// ============================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// 常量配置
// ============================================
const BRIDGE_DIR = __dirname;
const BRIDGE_PID_FILE = path.join(BRIDGE_DIR, 'bridge.pid');
const BRIDGE_SCRIPT = path.join(BRIDGE_DIR, 'server.js');
const BRIDGE_LOG = path.join(BRIDGE_DIR, 'server.log');
const BRIDGE_WS_URL = 'ws://localhost:51766';

// 心跳间隔（毫秒）
const HEARTBEAT_INTERVAL = 5000;

// 重连配置
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

// ============================================
// 全局状态
// ============================================

/** 最近一次选中的元素数据 */
let latestElement = null;

/** 元素接收时间戳 */
let latestElementTimestamp = null;

/** WebSocket 连接实例 */
let wsConnection = null;

/** 心跳定时器 */
let heartbeatTimer = null;

/** 客户端 ID */
const clientId = `mcp-${process.pid}-${Date.now()}`;

/** 重连延迟 */
let reconnectDelay = INITIAL_RECONNECT_DELAY;

/** 是否正在关闭 */
let isShuttingDown = false;

/** MCP 日志输出（避免污染 stdio 通道，写入文件） */
const LOG_FILE = path.join(BRIDGE_DIR, 'mcp-server.log');

/**
 * 写日志到文件（MCP Server 的 stdout 用于协议通信，不能用 console.log）
 *
 * @param {string} message - 日志内容
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    // 日志写入失败不影响主逻辑
  }
}

// ============================================
// Bridge Server 管理
// ============================================

/**
 * 确保 Bridge Server 运行
 *
 * 业务逻辑：
 * 1. 检查 PID 文件，验证进程是否存在
 * 2. 如果不存在，后台启动 Bridge Server
 * 3. 等待 Bridge Server 就绪（轮询端口，最多 3 秒）
 */
async function ensureBridgeRunning() {
  // 检查 PID 文件
  if (fs.existsSync(BRIDGE_PID_FILE)) {
    const pidContent = fs.readFileSync(BRIDGE_PID_FILE, 'utf8').trim();
    const pid = parseInt(pidContent, 10);

    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        log(`Bridge Server 已运行 (PID: ${pid})`);
        return;
      } catch (_) {
        // 进程不存在，清理 PID 文件
        try { fs.unlinkSync(BRIDGE_PID_FILE); } catch (_) { /* noop */ }
      }
    }
  }

  // 启动 Bridge Server
  log('正在启动 Bridge Server...');
  try {
    execSync(
      `cd "${BRIDGE_DIR}" && nohup node "${BRIDGE_SCRIPT}" > "${BRIDGE_LOG}" 2>&1 &`,
      { stdio: 'ignore', shell: '/bin/bash' }
    );

    // 等待启动完成（最多 3 秒，每 200ms 检查一次）
    const maxWait = 3000;
    const checkInterval = 200;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      try {
        // 尝试连接测试
        const ok = await testConnection();
        if (ok) {
          log('Bridge Server 启动成功');
          return;
        }
      } catch (_) {
        // 继续等待
      }
      await sleep(checkInterval);
    }

    log('Bridge Server 启动超时，将继续尝试连接');
  } catch (error) {
    log(`Bridge Server 启动失败: ${error.message}`);
  }
}

/**
 * 测试 WebSocket 连接是否可用
 *
 * @returns {Promise<boolean>} 连接是否成功
 */
function testConnection() {
  return new Promise((resolve) => {
    const testWs = new WebSocket(BRIDGE_WS_URL);
    const timer = setTimeout(() => {
      testWs.close();
      resolve(false);
    }, 500);

    testWs.once('open', () => {
      clearTimeout(timer);
      testWs.close();
      resolve(true);
    });

    testWs.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ============================================
// WebSocket 连接管理
// ============================================

/**
 * 连接到 Bridge Server（带自动重连）
 */
function connectToBridge() {
  if (isShuttingDown) return;

  log(`正在连接 Bridge: ${BRIDGE_WS_URL}`);
  wsConnection = new WebSocket(BRIDGE_WS_URL);

  wsConnection.on('open', () => {
    log('已连接到 Bridge Server');
    reconnectDelay = INITIAL_RECONNECT_DELAY;

    // 注册为 CLI 客户端
    register();

    // 启动心跳
    startHeartbeat();
  });

  wsConnection.on('message', (data) => {
    handleMessage(data);
  });

  wsConnection.on('close', () => {
    if (!isShuttingDown) {
      log('Bridge 连接断开，准备重连...');
      stopHeartbeat();
      scheduleReconnect();
    }
  });

  wsConnection.on('error', (error) => {
    log(`Bridge 连接错误: ${error.message}`);
  });
}

/**
 * 注册为 CLI 客户端
 *
 * 发送 register 消息到 Bridge Server，包含项目路径等信息
 */
function register() {
  const projectPath = process.cwd();
  const projectName = path.basename(projectPath);

  sendToWs({
    type: 'register',
    clientId,
    projectPath,
    projectName,
    tty: 'mcp-server',
    pid: process.pid,
  });

  log(`已注册: ${projectName} (MCP Server)`);
}

/**
 * 启动心跳（每 5 秒）
 */
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    sendToWs({
      type: 'heartbeat',
      clientId,
      timestamp: Date.now(),
    });
  }, HEARTBEAT_INTERVAL);
}

/**
 * 停止心跳
 */
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * 调度重连（指数退避）
 */
function scheduleReconnect() {
  if (isShuttingDown) return;

  log(`${reconnectDelay}ms 后重连...`);
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connectToBridge();
  }, reconnectDelay);
}

/**
 * 发送消息到 Bridge Server
 *
 * @param {Object} data - 消息对象
 */
function sendToWs(data) {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify(data));
  }
}

/**
 * 处理 Bridge 发来的消息（元素数据）
 *
 * 业务逻辑：
 * 1. 解析 JSON 消息
 * 2. 如果是 element 类型，缓存到内存
 *
 * @param {Buffer|string} data - 消息数据
 */
function handleMessage(data) {
  try {
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    const message = JSON.parse(raw);

    if (message.type === 'element') {
      latestElement = message.data;
      latestElementTimestamp = new Date().toISOString();
      log(`收到元素数据: ${latestElement.tagName || 'unknown'}${latestElement.id ? '#' + latestElement.id : ''}`);
    }
  } catch (error) {
    log(`消息解析失败: ${error.message}`);
  }
}

// ============================================
// 格式化输出
// ============================================

/**
 * 将元素数据格式化为 Markdown
 *
 * 复用 server.js 的 formatMarkdown 逻辑（TD8 规范）
 *
 * @param {Object} data - 元素信息对象
 * @returns {string} Markdown 格式文本
 */
function formatMarkdown(data) {
  const safeData = data || {};
  const tagName = safeData.tagName || '';
  const id = safeData.id || '';
  const className = safeData.className || '';
  const classLabel = typeof className === 'string'
    ? className.trim().split(/\s+/).filter(Boolean).join('.')
    : '';
  const title = `${tagName || 'element'}${id ? `#${id}` : ''}${classLabel ? `.${classLabel}` : ''}`;
  const cssSelector = safeData.cssSelector || '';
  const xpath = safeData.xpath || '';
  const textContent = safeData.textContent || '';
  const rect = safeData.boundingRect || {};
  const width = Number.isFinite(rect.width) ? rect.width : '';
  const height = Number.isFinite(rect.height) ? rect.height : '';
  const attributes = safeData.attributes || {};
  const computedStyles = safeData.computedStyles || safeData.styles || {};
  const outerHTML = safeData.outerHTML || '';

  const attrRows = Object.entries(attributes)
    .map(([k, v]) => `| ${escapeCell(k)} | ${escapeCell(String(v))} |`);
  const styleRows = Object.entries(computedStyles)
    .map(([k, v]) => `| ${escapeCell(k)} | ${escapeCell(String(v))} |`);

  return [
    `## Web Inspector: ${title}`,
    '',
    `**选择器**: \`${cssSelector}\``,
    `**XPath**: \`${xpath}\``,
    `**标签**: ${tagName}`,
    `**ID**: ${id}`,
    `**类名**: ${className}`,
    `**文本**: ${textContent}`,
    `**尺寸**: ${width} x ${height}`,
    '',
    '### 属性',
    '| 属性 | 值 |',
    '|------|---|',
    ...attrRows,
    '',
    '### 关键样式',
    '| 属性 | 值 |',
    '|------|---|',
    ...styleRows,
    '',
    '### HTML',
    '```html',
    outerHTML,
    '```',
  ].join('\n');
}

/**
 * Markdown 表格单元格转义
 *
 * @param {string} text - 待转义文本
 * @returns {string} 转义后文本
 */
function escapeCell(text) {
  return String(text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ============================================
// 工具函数
// ============================================

/**
 * 异步延迟
 *
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// MCP Server 创建与启动
// ============================================

/**
 * 创建 MCP 服务器实例
 *
 * 配置 capabilities 声明支持工具调用
 */
const mcpServer = new Server(
  {
    name: 'web-inspector',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * 注册工具列表处理器
 *
 * 返回可用的 MCP 工具定义
 */
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_selected_element',
        description:
          '获取浏览器中最近一次通过 Web Inspector 选中的页面元素数据。' +
          '返回元素的 CSS 选择器、XPath、属性、计算样式、HTML 内容等完整信息。' +
          '使用前需确保浏览器中已安装并启用 Web Inspector 油猴脚本。',
        inputSchema: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['json', 'markdown'],
              description: '返回格式：json（结构化数据）或 markdown（可读格式）。默认 json',
            },
          },
          required: [],
        },
      },
    ],
  };
});

/**
 * 注册工具调用处理器
 *
 * 处理 Claude 发起的工具调用请求
 */
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  log(`工具调用: ${name}, 参数: ${JSON.stringify(args)}`);

  if (name === 'get_selected_element') {
    // 检查是否有元素数据
    if (!latestElement) {
      return {
        content: [
          {
            type: 'text',
            text: [
              '暂无选中的元素数据。',
              '',
              '请在浏览器中操作：',
              '1. 确保已安装 Web Inspector 油猴脚本',
              '2. 点击页面右下角的紫色悬浮按钮激活选择器',
              '3. 点击要检查的页面元素',
              '4. 然后再次调用此工具获取数据',
            ].join('\n'),
          },
        ],
      };
    }

    const format = (args && args.format) || 'json';

    if (format === 'markdown') {
      return {
        content: [
          {
            type: 'text',
            text: formatMarkdown(latestElement),
          },
        ],
      };
    }

    // 默认 JSON 格式，附带捕获时间戳
    const result = {
      capturedAt: latestElementTimestamp,
      element: latestElement,
    };
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  // 未知工具
  return {
    content: [
      {
        type: 'text',
        text: `未知工具: ${name}`,
      },
    ],
    isError: true,
  };
});

// ============================================
// 主入口
// ============================================

/**
 * MCP Server 启动入口
 *
 * 业务逻辑：
 * 1. 确保 Bridge Server 运行
 * 2. 连接 Bridge Server 的 WebSocket
 * 3. 启动 MCP stdio 传输，等待 Claude 调用
 */
async function main() {
  log('=== Web Inspector MCP Server 启动 ===');

  // 1. 确保 Bridge Server 运行
  await ensureBridgeRunning();

  // 2. 连接 Bridge Server
  connectToBridge();

  // 3. 启动 MCP stdio 传输
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log('MCP Server 已就绪，等待 Claude 调用...');

  // 优雅退出
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * 优雅关闭
 */
function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log('MCP Server 正在关闭...');
  stopHeartbeat();

  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
  }

  log('MCP Server 已关闭');
  process.exit(0);
}

// 启动
main().catch((error) => {
  log(`MCP Server 启动失败: ${error.message}`);
  process.exit(1);
});
