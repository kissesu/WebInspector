# Web Inspector for Claude Code

> **项目简介**: 浏览器端元素选择器，选中网页元素后通过 Bridge Server 自动推送到 Claude Code CLI 会话

---

## 快速开始

### 1. 启动 Bridge 服务器

Bridge Server 通过 Claude Code SessionStart Hook 自动启动，无需手动操作。

手动启动方式:

```bash
cd bridge
./start-bridge.sh
```

或直接运行:

```bash
cd bridge
node server.js
```

**可选参数**:
- `--port <端口号>` - 指定 WebSocket 端口（默认 51765）

---

### 2. 安装油猴脚本

1. 确保浏览器已安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 打开文件 `src/web-inspector.user.js`
3. 将脚本内容复制到 Tampermonkey 的新脚本中并保存
4. 刷新任意网页

---

### 3. 使用 Web Inspector

1. 打开任意网页
2. 点击 Tampermonkey 菜单 -> **"Web Inspector (点击启用)"**
3. 右下角出现 Ghost 幽灵图标（颜色表示连接状态）
4. 点击 Ghost 图标激活选择器（图标变为绿色）
5. 鼠标悬停在页面元素上，出现高亮框
6. 点击元素完成选择，数据自动推送到 Claude Code 会话
7. 可连续选择多个元素，无需重复激活
8. 再次点击 Ghost 图标关闭选择器

---

## 系统架构

```
Browser (Tampermonkey)          Bridge Server (Node.js)         Claude Code (Ghostty)
+---------------------+        +---------------------+        +---------------------+
| Web Inspector        |  WS   | server.js            |  Push  | CLI TUI              |
| - 元素选择器          | -----> | - 浏览器端 WS :51765  | -----> | - 自动粘贴到输入框    |
| - 数据采集器          |        | - 订阅端 WS :51766   |        |                     |
| - Ghost UI           |        | - AppleScript 粘贴   |        +---------------------+
+---------------------+        | - MCP Server 转发    |
                               +---------------------+
                                        |
                                        | Pull (备用)
                                        v
                               +---------------------+
                               | MCP Server           |
                               | get_selected_element |
                               +---------------------+
```

**双通道架构**:
- **Push (主通道)**: Bridge Server 通过 AppleScript System Events 自动粘贴到 Ghostty 终端
- **Pull (备用通道)**: MCP Server 缓存最新元素数据，Claude 可通过工具主动获取

---

## 项目结构

```
WebInspector/
├── src/
│   └── web-inspector.user.js   # 油猴脚本（浏览器端）
├── bridge/
│   ├── server.js                # Bridge Server（WebSocket + 自动粘贴）
│   ├── mcp-server.mjs           # MCP Server（Pull 通道）
│   ├── start-bridge.sh          # 启动脚本（Hook 调用）
│   ├── package.json             # Node.js 依赖配置
│   ├── CLAUDE.md                # Bridge 模块开发规范
│   └── README.md                # Bridge 模块文档
├── openspec/
│   ├── specs/                   # 技术规范文档
│   └── changes/                 # 变更记录和任务规划
└── README.md                    # 本文件
```

---

## 核心功能

### 浏览器端（油猴脚本）

- **元素选择器**: 捕获阶段事件监听，支持 Shadow DOM
- **数据采集器**: 生成 CSS 选择器/XPath、采集属性/样式/HTML
- **WebSocket 通信**: 自动连接/断线重连/指数退避策略
- **Ghost UI**: 透明背景幽灵图标，颜色随状态变化（Shadow DOM 隔离）
- **连续选择模式**: 选中元素后 Inspector 保持激活，可连续选择
- **持久化配置**: 启用状态 + 自定义端口（GM_setValue）

### 服务器端（Bridge）

- **WebSocket 双端口**: 浏览器端口 51765 + 订阅端口 51766
- **自动粘贴推送**: AppleScript System Events 粘贴到 Ghostty 终端
- **剪贴板保护**: 粘贴前保存、粘贴后恢复用户剪贴板
- **MCP Server**: 提供 `get_selected_element` 工具供 Claude 主动获取
- **PID 文件锁**: 启动前优雅终止旧进程
- **SessionStart Hook**: Claude Code 启动时自动启动 Bridge

---

## Ghost 图标状态

| 状态 | 图标颜色 | 含义 |
|------|----------|------|
| 断开连接 | 红色 | Bridge Server 未连接 |
| 正在连接 | 黄色（脉动） | WebSocket 正在建立连接 |
| 已连接 | 紫色 | 已连接到 Bridge Server |
| Inspector 激活 | 绿色（发光） | 元素选择器已激活，可点选元素 |

---

## 配置选项

### 油猴脚本配置

**通过菜单配置**（无需编辑代码）:
1. 点击 Tampermonkey 菜单
2. 选择 "设置 WebSocket 端口"
3. 输入端口号（1-65535）

**代码级配置**（`src/web-inspector.user.js`）:
```javascript
const Config = {
  WS_URL: 'ws://localhost:51765',  // WebSocket 地址
  MAX_RETRIES: 5,                  // 最大重连次数
  RETRY_INTERVAL: 3000,            // 重连间隔（毫秒）
  MAX_DATA_SIZE: 5120,             // JSON 数据大小限制（字符）
  TEXT_LIMITS: {                   // 文本字段截断限制
    textContent: 500,
    innerHTML: 2000,
    outerHTML: 3000
  }
};
```

### Bridge 服务器配置

**通过命令行参数**:
```bash
node server.js --port 9999
```

**代码级配置**（`bridge/server.js`）:
```javascript
const DEFAULT_PORT = 51765;      // 默认端口
const PID_FILE = 'bridge.pid';   // PID 文件路径
```

---

## 与 Claude Code 集成

### 自动粘贴模式（默认）

Bridge Server 通过 SessionStart Hook 自动启动。在浏览器中选中元素后:

1. 元素数据通过 WebSocket 发送到 Bridge Server
2. Bridge Server 格式化数据并通过 AppleScript 粘贴到 Ghostty 终端
3. 数据出现在 Claude Code 输入框中（不自动提交）
4. 用户可追加指令后手动提交

### MCP 工具模式（备用）

Claude 可通过 MCP 工具主动获取最新选中的元素:

```
使用 get_selected_element 工具获取浏览器中选中的元素信息
```

---

## 常见问题

### Q1: Ghost 图标不显示？

**A**: 检查以下几点:
1. Tampermonkey 菜单中是否已启用 Web Inspector
2. 浏览器控制台是否有错误日志
3. 刷新页面并重新启用

---

### Q2: Ghost 图标为红色（连接失败）？

**A**: 检查 Bridge Server 是否运行:
```bash
# 检查 Bridge Server 进程
lsof -i :51765

# 手动启动
cd bridge && ./start-bridge.sh
```

---

### Q3: 选中元素后 Claude Code 没有收到数据？

**A**: 检查以下几点:
1. Ghost 图标是否为绿色（Inspector 激活）
2. 系统偏好设置中是否已授予终端 Accessibility 权限
3. 检查 Bridge Server 日志: `bridge/server.log`

---

### Q4: 端口被占用无法启动？

**A**: Bridge 会自动尝试端口 +1 重试（最多 3 次）:
- 默认端口: 51765
- 重试端口: 51766, 51767

手动指定端口:
```bash
node server.js --port 52000
```

然后在油猴脚本中通过菜单 "设置 WebSocket 端口" 更新端口号。

---

## 技术规范

详细的技术规范和设计文档请参考:

- **需求规格书**: `openspec/changes/web-inspector-tampermonkey/proposal.md`
- **系统设计**: `openspec/changes/web-inspector-tampermonkey/design.md`
- **自动粘贴方案**: `openspec/changes/bridge-auto-paste-push/proposal.md`
- **Ghost UI 规范**: `openspec/changes/web-inspector-tampermonkey/specs/ghost-ui.md`
- **Bridge Server 规范**: `openspec/changes/web-inspector-tampermonkey/specs/bridge-server.md`

---

## 许可证

本项目为个人学习项目，仅供参考。

---

## 作者

**Atlas.oi**
项目创建日期: 2026-02-08
