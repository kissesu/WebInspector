/**
 * @file Web Inspector for Claude Code - 油猴脚本主文件
 * @description 浏览器端元素选择器，选中页面元素并通过 WebSocket 发送到 Claude Code CLI
 * @author Atlas.oi
 * @date 2026-02-08
 */

// ==UserScript==
// @name         Web Inspector for Claude Code
// @namespace    https://github.com/kissesu/WebInspector
// @version      1.0.0
// @description  选中页面元素并发送到 Claude Code CLI
// @author       Atlas.oi
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function() {
  'use strict';

  // ============================================
  // 配置常量
  // ============================================
  const Config = {
    WS_URL: 'ws://localhost:51765',
    MAX_RETRIES: 5,
    RETRY_INTERVAL: 3000,
    MAX_DATA_SIZE: 5120,
    TEXT_LIMITS: {
      textContent: 500,
      innerHTML: 2000,
      outerHTML: 3000
    },
    STYLE_WHITELIST: {
      // 布局
      display: true,
      position: true,
      top: true,
      left: true,
      right: true,
      bottom: true,
      width: true,
      height: true,
      // 盒模型
      margin: true,
      padding: true,
      border: true,
      // 文本
      fontSize: true,
      fontFamily: true,
      fontWeight: true,
      color: true,
      textAlign: true,
      // 背景
      backgroundColor: true,
      backgroundImage: true,
      // 其他
      zIndex: true,
      opacity: true,
      cursor: true
    }
  };

  // ============================================
  // 状态管理
  // ============================================
  const State = {
    inspectorState: 'IDLE', // IDLE | INSPECTING | PICKED
    connectionState: 'DISCONNECTED', // DISCONNECTED | CONNECTING | CONNECTED
    currentTarget: null,
    lastCollectedData: null
  };

  // ============================================
  // 模块定义 (空壳，后续任务填充)
  // ============================================

  /**
   * Inspector 模块 - 元素选择器核心（阶段 2 改进：添加 Tooltip）
   */
  const Inspector = {
    isActive: false,
    currentTarget: null,
    overlay: null,
    tooltip: null, // 新增：元素标签 Tooltip
    _rafPending: false,

    /**
     * 激活选择器
     */
    activate() {
      if (this.isActive) return;
      this.isActive = true;
      this.createOverlay();
      this.createTooltip(); // 新增：创建 Tooltip
      this.bindEvents();
    },

    /**
     * 停用选择器
     */
    deactivate() {
      if (!this.isActive) return;
      this.isActive = false;
      this.unbindEvents();
      if (this.overlay) {
        this.overlay.style.display = 'none';
      }
      if (this.tooltip) {
        this.tooltip.style.display = 'none';
      }
      this.currentTarget = null;

      // 同步重置 Ghost 按钮视觉状态，确保按钮恢复到未激活样式
      if (typeof UI !== 'undefined' && UI.ghostButton) {
        UI.ghostButton.classList.remove('active');
      }
    },

    /**
     * 创建或显示遮罩层 (TD18/TD21)
     */
    createOverlay() {
      if (this.overlay) {
        this.overlay.style.display = 'block';
        return;
      }
      this.overlay = document.createElement('div');
      this.overlay.id = 'web-inspector-overlay';
      Object.assign(this.overlay.style, {
        position: 'fixed',
        zIndex: '2147483647',
        pointerEvents: 'none',
        backgroundColor: 'rgba(108, 92, 231, 0.15)',
        border: '2px solid rgba(108, 92, 231, 0.8)',
        boxSizing: 'border-box',
        transition: 'all 0.1s ease',
        display: 'block'
      });
      document.body.appendChild(this.overlay);
    },

    /**
     * 创建或显示元素标签 Tooltip（阶段 2 新增）
     *
     * 业务逻辑：
     * 1. 如果 tooltip 已存在，直接显示
     * 2. 创建新的 tooltip 节点
     * 3. 应用深色背景 + 等宽字体样式（参考 Enso）
     * 4. 添加到 document.body（与 overlay 同级）
     */
    createTooltip() {
      if (this.tooltip) {
        this.tooltip.style.display = 'block';
        return;
      }
      this.tooltip = document.createElement('div');
      this.tooltip.id = 'web-inspector-tooltip';
      Object.assign(this.tooltip.style, {
        position: 'fixed',
        zIndex: '2147483646', // 低于 overlay，避免遮挡高亮框
        pointerEvents: 'none',
        backgroundColor: 'rgba(28, 28, 30, 0.95)',
        color: '#ffffff',
        fontFamily: 'Menlo, Monaco, "JetBrains Mono", "Courier New", monospace',
        fontSize: '12px',
        padding: '4px 8px',
        borderRadius: '4px',
        whiteSpace: 'nowrap',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        transition: 'opacity 0.15s ease-out, transform 0.15s ease-out',
        opacity: '0',
        transform: 'translateY(-4px)',
        display: 'block'
      });
      document.body.appendChild(this.tooltip);
    },

    /**
     * 绑定事件监听器（捕获阶段）
     */
    bindEvents() {
      this._handleMouseOver = this.handleMouseOver.bind(this);
      this._handleClick = this.handleClick.bind(this);
      this._handleScroll = this.handleScroll.bind(this);
      this._handleResize = this.handleResize.bind(this);
      this._handleKeyDown = this.handleKeyDown.bind(this);

      window.addEventListener('mouseover', this._handleMouseOver, true);
      window.addEventListener('click', this._handleClick, true);
      window.addEventListener('scroll', this._handleScroll, { capture: true, passive: true });
      window.addEventListener('resize', this._handleResize, { capture: true, passive: true });
      window.addEventListener('keydown', this._handleKeyDown, true);
      // 监听 document 滚动，覆盖滚动容器内的滚动
      document.addEventListener('scroll', this._handleScroll, { capture: true, passive: true });
    },

    /**
     * 移除事件监听器
     */
    unbindEvents() {
      window.removeEventListener('mouseover', this._handleMouseOver, true);
      window.removeEventListener('click', this._handleClick, true);
      window.removeEventListener('scroll', this._handleScroll, { capture: true, passive: true });
      window.removeEventListener('resize', this._handleResize, { capture: true, passive: true });
      window.removeEventListener('keydown', this._handleKeyDown, true);
      document.removeEventListener('scroll', this._handleScroll, { capture: true, passive: true });
    },

    /**
     * 获取事件目标，支持 Shadow DOM (Task 4.2)
     *
     * 业务逻辑：
     * 1. 使用 composedPath 获取最内层目标（支持 Shadow DOM）
     * 2. 规范化为 Element 节点（Text 节点会导致 getBoundingClientRect 崩溃）
     */
    getEventTarget(event) {
      let target;
      if (event.composedPath && typeof event.composedPath === 'function') {
        const path = event.composedPath();
        target = path.length > 0 ? path[0] : event.target;
      } else {
        target = event.target;
      }

      // 规范化为 Element 节点（防止 Text 节点导致崩溃）
      if (target && target.nodeType !== 1) {
        target = target.parentElement;
      }

      return target;
    },

    /**
     * 检测是否为插件自身的 UI（Task 4.5 - 阶段 2 改进）
     *
     * 业务逻辑：
     * 1. 检查是否为 overlay 自身
     * 2. 检查是否为 tooltip 自身（新增）
     * 3. 检查是否在 UI.host 容器内（Shadow DOM 根容器）
     * 4. 检查 Shadow Root（兼容 UI 未初始化情况）
     */
    isOwnUI(target) {
      if (!target) return false;
      if (target === this.overlay) return true;
      if (target === this.tooltip) return true; // 新增：检测 tooltip
      if (UI && UI.host && UI.host.contains(target)) return true;
      if (UI && UI.shadowRoot && target.getRootNode && target.getRootNode() === UI.shadowRoot) return true;
      return false;
    },

    /**
     * 处理鼠标悬停（阶段 2 改进：同时更新 Tooltip）
     */
    handleMouseOver(event) {
      const target = this.getEventTarget(event);
      if (!target || target === this.currentTarget || this.isOwnUI(target)) return;
      this.currentTarget = target;
      this.requestUpdate(); // 使用 rAF 批次更新（性能优化）
    },

    /**
     * 更新遮罩层位置和大小 (Task 4.3)
     */
    updateOverlay() {
      if (!this.isActive || !this.currentTarget || !this.overlay) return;
      const rect = this.currentTarget.getBoundingClientRect();
      Object.assign(this.overlay.style, {
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
      });
    },

    /**
     * 更新元素标签 Tooltip（阶段 2 改进 - 参考 Enso 简化实现）
     *
     * 业务逻辑（参考 Enso Web Inspector）：
     * 1. 优先显示 tag#id
     * 2. 否则显示 tag.class（最多 2 个类名）
     * 3. 都没有就显示 tagName
     * 4. 智能定位：元素上方，贴顶时翻转至元素下方
     */
    updateTooltip() {
      if (!this.isActive || !this.currentTarget || !this.tooltip) return;

      const el = this.currentTarget;
      const tag = el.tagName ? el.tagName.toLowerCase() : 'unknown';

      let displayText = tag;

      // 优先显示 ID
      if (el.id) {
        displayText = `${tag}#${el.id}`;
      }
      // 否则显示 class（最多 2 个类名，过滤伪类）
      else if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim()
          .split(/\s+/)
          .filter(c => c && !c.includes(':'))
          .slice(0, 2);
        if (classes.length) {
          displayText = `${tag}.${classes.join('.')}`;
        }
      }

      this.tooltip.textContent = displayText;

      // 智能定位：基于元素位置自动避让
      const rect = this.currentTarget.getBoundingClientRect();
      const tooltipHeight = 24; // 预估高度
      const margin = 4; // 与元素的间距

      if (rect.top < tooltipHeight + margin + 10) {
        // 元素贴近视口顶部，显示在元素下方
        this.tooltip.style.top = `${rect.bottom + margin}px`;
      } else {
        // 显示在元素上方
        this.tooltip.style.top = `${rect.top - tooltipHeight - margin}px`;
      }

      this.tooltip.style.left = `${rect.left}px`;

      // 显示动画（透明度 + 位移）
      this.tooltip.style.opacity = '1';
      this.tooltip.style.transform = 'translateY(0)';
    },

    /**
     * 处理点击选择（Task 4.4 - 阶段 3 改进：移除弹窗 + Toast 反馈）
     *
     * 业务逻辑：
     * 1. 检查是否点击自身 UI（如果是则直接返回，不干扰 UI 交互）
     * 2. 阻止默认行为和传播（防止触发链接跳转等）
     * 3. 调用 Collector 采集数据
     * 4. 通过 Transport 发送数据
     * 5. 显示轻量级 Toast 提示（替代弹窗）
     */
    handleClick(event) {
      if (!this.isActive) return;

      const target = this.getEventTarget(event);
      if (this.isOwnUI(target)) return;

      // 阻止默认行为和传播，防止触发链接跳转等
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      // 使用点击时的目标，而非 mouseover 缓存的目标（更可靠）
      const clickTarget = target || this.currentTarget;

      if (clickTarget) {
        // 调用采集器获取数据
        const data = Collector.collect ? Collector.collect(clickTarget) : null;
        // 通过传输模块发送数据
        Transport.sendElement(data);

        // 轻量级 Toast 提示发送成功
        if (UI.showToast) UI.showToast('Sent to Bridge', 'success');

        State.inspectorState = 'PICKED';
      }

      // 发送后保持 Inspector 激活状态，用户可连续选择元素
      // 手动点击 Ghost 按钮才会关闭 Inspector
    },

    /**
     * 处理滚动 (rAF 节流)
     */
    handleScroll() {
      this.requestUpdate();
    },

    /**
     * 处理窗口大小调整 (rAF 节流)
     */
    handleResize() {
      this.requestUpdate();
    },

    /**
     * rAF 节流请求更新（TD18 - 阶段 2 改进：同时更新 Tooltip）
     */
    requestUpdate() {
      if (this._rafPending) return;
      this._rafPending = true;
      requestAnimationFrame(() => {
        this.updateOverlay();
        this.updateTooltip(); // 新增：同时更新 Tooltip
        this._rafPending = false;
      });
    },

    /**
     * 处理按键 (ESC 退出)
     */
    handleKeyDown(event) {
      if (event.key === 'Escape') {
        this.deactivate();
      }
    }
  };

  /**
   * Collector 模块 - 元素数据采集
   */
  const Collector = {
    /**
     * 获取 className（兼容 SVGAnimatedString）
     */
    getClassName(element) {
      if (!element) return '';
      if (typeof element.className === 'string') {
        return element.className.trim();
      }
      if (element.className && typeof element.className.baseVal === 'string') {
        return element.className.baseVal.trim();
      }
      return '';
    },

    /**
     * CSS.escape 安全封装
     */
    _escapeCss(value) {
      const text = String(value || '');
      if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(text);
      }
      return text.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
    },

    /**
     * 判断是否为动态哈希类名
     */
    _isDynamicClass(className) {
      if (!className) return true;
      if (/^[a-f0-9]{6,}$/i.test(className)) return true;
      if (/^(css|sc|jsx)-[a-z0-9]{6,}$/i.test(className)) return true;
      if (className.length >= 20 && /[0-9]/.test(className) && /[a-z]/i.test(className)) return true;
      return false;
    },

    /**
     * 获取 nth-of-type 序号
     */
    _getNthOfTypeIndex(element) {
      if (!element || !element.tagName) return 1;
      const tagName = element.tagName;
      let index = 1;
      let sibling = element.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === tagName) {
          index += 1;
        }
        sibling = sibling.previousElementSibling;
      }
      return index;
    },

    /**
     * 选择器唯一性验证
     */
    _isSelectorUnique(selector, element) {
      if (!selector) return false;
      try {
        const matches = document.querySelectorAll(selector);
        return matches.length === 1 && matches[0] === element;
      } catch (error) {
        return false;
      }
    },

    /**
     * 选择器匹配验证
     */
    _isSelectorMatch(selector, element) {
      if (!selector) return false;
      try {
        return document.querySelector(selector) === element;
      } catch (error) {
        return false;
      }
    },

    /**
     * 构建路径片段
     */
    _getElementSegment(element) {
      if (!element || !element.tagName) return '';
      const tagName = element.tagName.toLowerCase();

      if (element.id) {
        return `#${this._escapeCss(element.id)}`;
      }

      const className = this.getClassName(element);
      const classes = className
        .split(/\s+/)
        .filter(Boolean)
        .filter((name) => !this._isDynamicClass(name));

      if (classes.length > 0) {
        const classSelector = classes.map((name) => `.${this._escapeCss(name)}`).join('');
        return `${tagName}${classSelector}`;
      }

      const index = this._getNthOfTypeIndex(element);
      return `${tagName}:nth-of-type(${index})`;
    },

    /**
     * 生成 CSS 选择器（TD4）
     */
    generateSelector(element) {
      if (!element || element.nodeType !== 1 || !element.tagName) return null;

      const tagName = element.tagName.toLowerCase();

      // 1. ID 唯一性
      if (element.id) {
        const idSelector = `#${this._escapeCss(element.id)}`;
        if (this._isSelectorUnique(idSelector, element)) {
          return idSelector;
        }
      }

      // 2. Class 组合
      const className = this.getClassName(element);
      const classes = className
        .split(/\s+/)
        .filter(Boolean)
        .filter((name) => !this._isDynamicClass(name));

      if (classes.length > 0) {
        const fullSelector = `${tagName}${classes.map((name) => `.${this._escapeCss(name)}`).join('')}`;
        if (this._isSelectorUnique(fullSelector, element)) {
          return fullSelector;
        }

        for (const name of classes) {
          const singleSelector = `${tagName}.${this._escapeCss(name)}`;
          if (this._isSelectorUnique(singleSelector, element)) {
            return singleSelector;
          }
        }
      }

      // 3. tagName:nth-of-type(n) - 必须保证唯一性
      const nthIndex = this._getNthOfTypeIndex(element);
      const nthSelector = `${tagName}:nth-of-type(${nthIndex})`;
      if (this._isSelectorUnique(nthSelector, element)) {
        return nthSelector;
      }

      // 4. 递归拼接父级（最多 5 层）- 必须保证唯一性
      const maxDepth = 5;
      let current = element;
      const segments = [];
      let depth = 0;
      while (current && current.nodeType === 1 && depth < maxDepth) {
        segments.unshift(this._getElementSegment(current));
        const candidate = segments.join(' > ');
        if (this._isSelectorUnique(candidate, element)) {
          return candidate;
        }
        current = current.parentElement;
        depth += 1;
      }

      // 5. 扩展到完整路径 - 优先返回唯一选择器，否则返回完整路径
      current = element;
      segments.length = 0;
      let lastCandidate = null;
      while (current && current.nodeType === 1) {
        segments.unshift(this._getElementSegment(current));
        const candidate = segments.join(' > ');
        lastCandidate = candidate; // 保存最后一个候选
        if (this._isSelectorUnique(candidate, element)) {
          return candidate;
        }
        current = current.parentElement;
      }

      // 即使不唯一，也返回完整路径（总比 null 好）
      return lastCandidate || null;
    },

    /**
     * 生成 XPath（TD4.2）
     */
    generateXPath(element) {
      if (!element || element.nodeType !== 1 || !element.tagName) return null;

      const segments = [];
      let current = element;

      while (current && current.nodeType === 1 && current.tagName) {
        const tagName = current.tagName.toLowerCase();
        const isSvg = typeof SVGElement !== 'undefined' && current instanceof SVGElement;
        let segment = isSvg ? `*[local-name()='${tagName}']` : tagName;

        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.tagName && sibling.tagName.toLowerCase() === tagName) {
            index += 1;
          }
          sibling = sibling.previousElementSibling;
        }

        let hasSameTag = false;
        sibling = current.nextElementSibling;
        while (sibling) {
          if (sibling.tagName && sibling.tagName.toLowerCase() === tagName) {
            hasSameTag = true;
            break;
          }
          sibling = sibling.nextElementSibling;
        }

        if (index > 1 || hasSameTag) {
          segment += `[${index}]`;
        }

        segments.unshift(segment);
        current = current.parentElement;
      }

      return `/${segments.join('/')}`;
    },

    /**
     * 采集样式（白名单）
     */
    collectStyles(element) {
      const styles = {};
      if (!element || typeof window.getComputedStyle !== 'function') {
        return styles;
      }

      let computed;
      try {
        computed = window.getComputedStyle(element);
      } catch (error) {
        return styles;
      }

      if (!computed) return styles;

      const keys = Object.keys(Config.STYLE_WHITELIST);
      for (const key of keys) {
        const cssKey = key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
        let value = '';

        if (typeof computed.getPropertyValue === 'function') {
          value = computed.getPropertyValue(cssKey);
        }
        if (!value && computed[key]) {
          value = computed[key];
        }

        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (trimmed) {
            styles[key] = trimmed;
          }
        } else if (value !== undefined && value !== null) {
          styles[key] = String(value);
        }
      }

      return styles;
    },

    /**
     * 字符串截断工具
     */
    _truncateString(value, maxLength) {
      if (typeof value !== 'string') return '';
      if (maxLength <= 0) return '';
      if (value.length <= maxLength) return value;
      if (maxLength <= 3) return value.slice(0, maxLength);
      return `${value.slice(0, maxLength - 3)}...`;
    },

    /**
     * 数据大小限制（TD15）
     */
    truncateToFit(data) {
      const maxSize = Config.MAX_DATA_SIZE;
      const result = {
        tagName: data.tagName || '',
        id: data.id || '',
        className: data.className || '',
        attributes: data.attributes ? Object.assign({}, data.attributes) : {},
        textContent: data.textContent || '',
        innerHTML: data.innerHTML || '',
        outerHTML: data.outerHTML || '',
        cssSelector: data.cssSelector || '',
        xpath: data.xpath || '',
        computedStyles: data.computedStyles ? Object.assign({}, data.computedStyles) : {},
        boundingRect: data.boundingRect ? Object.assign({}, data.boundingRect) : null,
        parentContext: data.parentContext ? Object.assign({}, data.parentContext) : null
      };

      const getSize = (target) => JSON.stringify(target).length;
      let size = getSize(result);
      if (size <= maxSize) return result;

      const reduceStringField = (field) => {
        if (typeof result[field] !== 'string' || !result[field]) return;
        while (size > maxSize && result[field].length > 0) {
          const over = size - maxSize;
          const targetLen = Math.max(0, result[field].length - over - 8);
          if (targetLen >= result[field].length) {
            break;
          }
          result[field] = this._truncateString(result[field], targetLen);
          size = getSize(result);
          if (targetLen === 0) break;
        }
      };

      reduceStringField('outerHTML');
      if (size <= maxSize) return result;

      reduceStringField('innerHTML');
      if (size <= maxSize) return result;

      reduceStringField('textContent');
      if (size <= maxSize) return result;

      const trimAttributes = (limit) => {
        if (!result.attributes) return;
        const keys = Object.keys(result.attributes);
        for (const key of keys) {
          if (size <= maxSize) break;
          const value = result.attributes[key];
          if (typeof value === 'string' && value.length > limit) {
            result.attributes[key] = this._truncateString(value, limit);
            size = getSize(result);
          }
        }
      };

      trimAttributes(200);
      if (size <= maxSize) return result;

      trimAttributes(50);
      if (size <= maxSize) return result;

      trimAttributes(0);
      if (size <= maxSize) return result;

      result.computedStyles = {};
      size = getSize(result);
      if (size <= maxSize) return result;

      result.attributes = {};
      size = getSize(result);
      if (size <= maxSize) return result;

      result.parentContext = null;
      size = getSize(result);
      if (size <= maxSize) return result;

      result.boundingRect = null;
      size = getSize(result);
      if (size <= maxSize) return result;

      result.outerHTML = '';
      result.innerHTML = '';
      result.textContent = '';
      size = getSize(result);
      if (size <= maxSize) return result;

      result.cssSelector = this._truncateString(result.cssSelector || '', 100);
      result.xpath = this._truncateString(result.xpath || '', 100);
      return result;
    },

    /**
     * 主采集函数
     */
    collect(element) {
      if (!element || element.nodeType !== 1 || !element.tagName) return null;

      const tagName = element.tagName.toLowerCase();
      const className = this.getClassName(element);

      const attributes = {};
      if (element.attributes && element.attributes.length) {
        for (const attr of element.attributes) {
          attributes[attr.name] = attr.value;
        }
      }

      const textContent = this._truncateString(element.textContent || '', Config.TEXT_LIMITS.textContent);
      const innerHTML = this._truncateString(element.innerHTML || '', Config.TEXT_LIMITS.innerHTML);
      const outerHTML = this._truncateString(element.outerHTML || '', Config.TEXT_LIMITS.outerHTML);

      const xpath = this.generateXPath(element);
      const cssSelector = this.generateSelector(element) || (xpath ? `xpath:${xpath}` : '');

      const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
      const boundingRect = rect ? {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom
      } : null;

      const parent = element.parentElement;
      const parentContext = parent ? {
        tagName: parent.tagName ? parent.tagName.toLowerCase() : '',
        id: parent.id || '',
        className: this.getClassName(parent)
      } : null;

      const data = {
        tagName,
        id: element.id || '',
        className,
        attributes,
        textContent,
        innerHTML,
        outerHTML,
        cssSelector,
        xpath,
        computedStyles: this.collectStyles(element),
        boundingRect,
        parentContext
      };

      return this.truncateToFit(data);
    }
  };

  /**
   * Transport 模块 - WebSocket 通信
   */
  const Transport = {
    ws: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    isManualClose: false,
    isReconnecting: false,

    /**
     * 设置连接状态（避免重复更新）
     *
     * @param {string} nextState - DISCONNECTED | CONNECTING | CONNECTED
     */
    setState(nextState) {
      if (State.connectionState === nextState) {
        return;
      }
      State.connectionState = nextState;
    },

    /**
     * 重置重连计数器和定时器
     */
    resetReconnect() {
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    },

    /**
     * 连接 WebSocket 服务器
     *
     * 业务逻辑：
     * 1. 防重入检查（仅在 DISCONNECTED 状态下连接）
     * 2. 设置 isManualClose = false（标记为自动连接）
     * 3. 创建 WebSocket 并注册事件监听器
     * 4. open: 切换到 CONNECTED，重置重连计数
     * 5. close/error: 切换到 DISCONNECTED，非手动关闭则自动重连
     */
    connect() {
      if (State.connectionState !== 'DISCONNECTED') {
        return;
      }

      this.isManualClose = false;
      this.setState('CONNECTING');

      try {
        this.ws = new WebSocket(Config.WS_URL);
      } catch (error) {
        this.setState('DISCONNECTED');
        this.scheduleReconnect();
        return;
      }

      this.ws.addEventListener('open', () => {
        this.setState('CONNECTED');
        this.resetReconnect();
      });

      this.ws.addEventListener('close', () => {
        this.ws = null;
        this.setState('DISCONNECTED');
        if (!this.isManualClose && !this.isReconnecting) {
          this.isReconnecting = true;
          this.scheduleReconnect();
        }
      });

      this.ws.addEventListener('error', () => {
        if (this.ws) {
          try {
            this.ws.close();
          } catch (error) {
            // 忽略关闭失败
          }
        }
      });

      this.ws.addEventListener('message', () => {
        // 预留消息处理
      });
    },

    /**
     * 调度自动重连（指数退避策略）
     *
     * 业务逻辑：
     * - 重连间隔: RETRY_INTERVAL * 2^attempts
     * - 最大重试次数: MAX_RETRIES (5 次)
     * - 超过最大次数后停止重连
     */
    scheduleReconnect() {
      if (this.reconnectAttempts >= Config.MAX_RETRIES) {
        return;
      }
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const delay = Config.RETRY_INTERVAL * Math.pow(2, this.reconnectAttempts);
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, delay);
    },

    /**
     * 发送元素数据到服务器
     *
     * @param {Object} elementData - Collector.collect() 返回的元素数据
     */
    sendElement(elementData) {
      if (State.connectionState !== 'CONNECTED' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const payload = {
        type: 'element_selected',
        timestamp: new Date().toISOString(),
        data: elementData || null
      };

      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        // 忽略发送失败
      }
    },

    /**
     * 发送 ping 心跳包（Codex Review 新增）
     */
    sendPing() {
      if (State.connectionState !== 'CONNECTED' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      } catch (error) {
        // 忽略发送失败
      }
    },

    /**
     * 手动断开连接（TD12: 使用 isManualClose 阻止自动重连）
     *
     * 业务逻辑：
     * 1. 设置 isManualClose = true（阻止 close 事件触发自动重连）
     * 2. 清除重连定时器
     * 3. 关闭 WebSocket 连接
     * 4. 切换到 DISCONNECTED 状态
     */
    disconnect() {
      this.isManualClose = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.ws) {
        try {
          this.ws.close();
        } catch (error) {
          // 忽略关闭失败
        }
        this.ws = null;
      }
      this.setState('DISCONNECTED');
    }
  };

  /**
   * UI 模块 - Ghost 悬浮按钮和信息面板
   */
  const UI = {
    host: null,
    shadowRoot: null,
    ghostButton: null,
    infoPanel: null,
    _dragState: { active: false, x: 0, y: 0, startX: 0, startY: 0 },

    /**
     * 初始化 UI 组件
     */
    init() {
      this.createHost();
      this.injectStyles();
      this.renderGhostButton();
      this.renderInfoPanel();
      this.bindEvents();
    },

    /**
     * 创建 Shadow DOM 宿主
     */
    createHost() {
      this.host = document.createElement('div');
      this.host.id = 'web-inspector-ui';
      document.body.appendChild(this.host);
      this.shadowRoot = this.host.attachShadow({ mode: 'open' });
    },

    /**
     * 注入组件样式 (Task 5.1 - CSS Theming)
     */
    injectStyles() {
      const style = document.createElement('style');
      style.textContent = `
        :host {
          --primary: #6c5ce7;
          --primary-hover: #a29bfe;
          --bg: #ffffff;
          --bg-alt: #f9f9f9;
          --text: #2d3436;
          --text-muted: #636e72;
          --border: #dfe6e9;
          --shadow: 0 4px 20px rgba(0,0,0,0.15);
          --success: #00b894;
          --warning: #fdcb6e;
          --danger: #d63031;
          --radius: 8px;
          --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          
          font-family: var(--font);
          z-index: 2147483647;
          position: fixed;
          top: 0;
          left: 0;
          pointer-events: none;
        }

        .ghost-button {
          position: fixed;
          bottom: 20px;
          right: 20px;
          width: 48px;
          height: 48px;
          background: transparent;
          border: none;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          pointer-events: auto;
          transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275), filter 0.2s ease;
          user-select: none;
          color: var(--danger);
          filter: drop-shadow(0 2px 6px rgba(0,0,0,0.3));
        }

        .ghost-button:hover {
          transform: scale(1.15);
          filter: drop-shadow(0 4px 12px rgba(0,0,0,0.4));
        }

        .ghost-button.connected {
          color: var(--primary);
        }

        .ghost-button.connecting {
          color: var(--warning);
          animation: ghost-pulse 1.5s ease-in-out infinite;
        }

        .ghost-button.disconnected {
          color: var(--danger);
        }

        /* active 定义在连接状态之后，确保激活态绿色优先级最高 */
        .ghost-button.active {
          color: var(--success);
          transform: scale(1.15);
          filter: drop-shadow(0 0 8px rgba(0, 184, 148, 0.6));
        }

        @keyframes ghost-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.92); }
        }


        .info-panel {
          position: fixed;
          top: 20px;
          right: 20px;
          width: 320px;
          max-height: 80vh;
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
          display: none;
          flex-direction: column;
          pointer-events: auto;
          overflow: hidden;
        }

        .panel-header {
          padding: 12px 16px;
          background: var(--bg-alt);
          border-bottom: 1px solid var(--border);
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: move;
          user-select: none;
        }

        .panel-header h3 {
          margin: 0;
          font-size: 14px;
          color: var(--text);
        }

        .close-btn {
          cursor: pointer;
          font-size: 18px;
          color: var(--text-muted);
        }

        .panel-content {
          padding: 16px;
          overflow-y: auto;
          font-size: 12px;
          line-height: 1.5;
        }

        .data-row {
          margin-bottom: 12px;
        }

        .data-label {
          font-weight: bold;
          color: var(--text-muted);
          display: block;
          margin-bottom: 4px;
          text-transform: uppercase;
          font-size: 10px;
        }

        .data-value {
          background: var(--bg-alt);
          padding: 6px;
          border-radius: 4px;
          word-break: break-all;
          display: block;
          font-family: monospace;
          border: 1px solid var(--border);
        }

        .tag-badge {
          display: inline-block;
          padding: 2px 6px;
          background: var(--primary);
          color: white;
          border-radius: 4px;
          font-weight: bold;
          margin-bottom: 8px;
        }
      `;
      this.shadowRoot.appendChild(style);
    },

    /**
     * 渲染悬浮按钮
     */
    renderGhostButton() {
      this.ghostButton = document.createElement('div');
      this.ghostButton.className = 'ghost-button';
      this.ghostButton.innerHTML = `
        <svg viewBox="5 2 14 18" width="42" height="54" fill="currentColor">
          <path d="M12 2C8.13 2 5 5.13 5 9v11l2.5-1.5L10 20l2-1.5L14 20l2.5-1.5L19 20V9c0-3.87-3.13-7-7-7zm-2 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
        </svg>
      `;
      this.shadowRoot.appendChild(this.ghostButton);
      this.updateStatusUI();
    },

    /**
     * 渲染信息面板
     */
    renderInfoPanel() {
      this.infoPanel = document.createElement('div');
      this.infoPanel.className = 'info-panel';
      this.infoPanel.innerHTML = `
        <div class="panel-header">
          <h3>Element Details</h3>
          <span class="close-btn">&times;</span>
        </div>
        <div class="panel-content">
          <div class="data-row">
            <span class="data-label">Selected Element</span>
            <div id="info-tag-container"></div>
          </div>
          <div class="data-row">
            <span class="data-label">CSS Selector</span>
            <code id="info-selector" class="data-value">None selected</code>
          </div>
          <div class="data-row">
            <span class="data-label">Attributes</span>
            <div id="info-attrs" class="data-value">{}</div>
          </div>
        </div>
      `;
      this.shadowRoot.appendChild(this.infoPanel);
      this.setupDraggable();
    },

    /**
     * 绑定事件处理
     */
    bindEvents() {
      this.ghostButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleInspector();
      });

      this.infoPanel.querySelector('.close-btn').addEventListener('click', () => {
        this.hideInfoPanel();
      });

      // 劫持状态同步
      const originalSetState = Transport.setState;
      Transport.setState = (nextState) => {
        originalSetState.call(Transport, nextState);
        this.updateStatusUI();
      };
    },

    /**
     * 更新状态 UI (Task 5.2)
     */
    updateStatusUI() {
      if (!this.ghostButton) return;
      // 移除所有连接状态类，保留 active 类（Inspector 激活状态）
      this.ghostButton.classList.remove('connected', 'connecting', 'disconnected');

      switch (State.connectionState) {
        case 'CONNECTED': this.ghostButton.classList.add('connected'); break;
        case 'CONNECTING': this.ghostButton.classList.add('connecting'); break;
        default: this.ghostButton.classList.add('disconnected'); break;
      }
    },

    /**
     * 切换选择器状态
     */
    toggleInspector() {
      if (Inspector.isActive) {
        Inspector.deactivate();
        this.ghostButton.classList.remove('active');
      } else {
        Inspector.activate();
        this.ghostButton.classList.add('active');
        this.hideInfoPanel();
      }
    },

    /**
     * 显示元素信息 (Task 5.4)
     */
    displayElementInfo(data) {
      if (!data) return;
      
      this.infoPanel.style.display = 'flex';
      const tagContainer = this.shadowRoot.getElementById('info-tag-container');
      const selectorEl = this.shadowRoot.getElementById('info-selector');
      const attrsEl = this.shadowRoot.getElementById('info-attrs');

      tagContainer.innerHTML = `<span class="tag-badge">&lt;${data.tagName}&gt;</span>`;
      selectorEl.textContent = data.cssSelector;
      attrsEl.textContent = JSON.stringify(data.attributes, null, 2);
      
      this.ghostButton.classList.remove('active');
    },

    /**
     * 隐藏面板
     */
    hideInfoPanel() {
      this.infoPanel.style.display = 'none';
    },

    /**
     * 设置面板拖拽 (Task 5.3 - Pointer Events)
     */
    setupDraggable() {
      const header = this.infoPanel.querySelector('.panel-header');
      
      header.addEventListener('pointerdown', (e) => {
        this._dragState.active = true;
        this._dragState.startX = e.clientX - this.infoPanel.offsetLeft;
        this._dragState.startY = e.clientY - this.infoPanel.offsetTop;
        header.setPointerCapture(e.pointerId);
      });

      header.addEventListener('pointermove', (e) => {
        if (!this._dragState.active) return;
        
        const x = e.clientX - this._dragState.startX;
        const y = e.clientY - this._dragState.startY;
        
        this.infoPanel.style.left = `${x}px`;
        this.infoPanel.style.top = `${y}px`;
        this.infoPanel.style.right = 'auto'; // 取消默认的 right: 20px
      });

      header.addEventListener('pointerup', (e) => {
        this._dragState.active = false;
        header.releasePointerCapture(e.pointerId);
      });
    },

    /**
     * 显示通知 (预留方法)
     */
    showNotification(message, type = 'info') {
      console.log(`[UI Notification] ${type}: ${message}`);
    },

    /**
     * 显示 Toast 提示（阶段 3 新增）
     *
     * 业务逻辑：
     * 1. 创建 Toast 节点并应用样式
     * 2. 添加到 Shadow DOM 中（确保样式隔离）
     * 3. 1 秒后自动淡出并移除
     *
     * @param {string} message - 提示消息
     * @param {string} type - 提示类型（info | success | error）
     */
    showToast(message, type = 'info') {
      if (!this.shadowRoot) {
        console.warn('[Web Inspector] Shadow DOM 未初始化，无法显示 Toast');
        return;
      }

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.textContent = message;

      // 应用样式
      Object.assign(toast.style, {
        position: 'fixed',
        top: '20px',
        right: '20px',
        padding: '12px 20px',
        backgroundColor: type === 'success' ? '#00b894' : type === 'error' ? '#d63031' : '#6c5ce7',
        color: '#ffffff',
        borderRadius: '8px',
        fontSize: '14px',
        fontWeight: 'bold',
        boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
        zIndex: '2147483647',
        opacity: '0',
        transform: 'translateY(-10px)',
        transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        pointerEvents: 'none'
      });

      this.shadowRoot.appendChild(toast);

      // 进入动画
      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
      });

      // 1 秒后自动淡出
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        setTimeout(() => toast.remove(), 300);
      }, 1000);
    }
  };

  // ============================================
  // 激活/停用逻辑 (阶段 1 改进)
  // ============================================

  /**
   * 激活 Web Inspector
   *
   * 业务逻辑：
   * 1. 初始化 UI 组件（Ghost 按钮、Shadow DOM）
   * 2. 激活 Inspector 选择器（绑定事件监听）
   * 3. 连接 WebSocket 服务器
   */
  function activateInspector() {
    console.log('[Web Inspector] 正在激活...');
    UI.init();
    Inspector.activate();
    Transport.connect();
    // 同步 Ghost 按钮激活状态（页面刷新恢复时需要）
    if (UI.ghostButton) {
      UI.ghostButton.classList.add('active');
    }
    console.log('[Web Inspector] 已激活');
  }

  /**
   * 停用 Web Inspector
   *
   * 业务逻辑：
   * 1. 停用 Inspector 选择器（移除事件监听）
   * 2. 断开 WebSocket 连接
   * 3. 隐藏 UI 组件（保留 Ghost 按钮）
   */
  function deactivateInspector() {
    console.log('[Web Inspector] 正在停用...');
    Inspector.deactivate();
    Transport.disconnect();
    // UI 保留 Ghost 按钮，隐藏其他组件
    if (UI.infoPanel) {
      UI.hideInfoPanel();
    }
    console.log('[Web Inspector] 已停用');
  }

  // ============================================
  // 油猴菜单命令处理 (Task 7.3 - 阶段 1 改进)
  // ============================================

  /**
   * 切换 Web Inspector 启用状态
   *
   * 改进：移除 location.reload()，直接调用激活/停用逻辑
   */
  function toggleEnabled() {
    const currentState = GM_getValue('enabled', false);
    const newState = !currentState;
    GM_setValue('enabled', newState);

    if (newState) {
      activateInspector();
      console.log('[Web Inspector] 已通过菜单启用');
    } else {
      deactivateInspector();
      console.log('[Web Inspector] 已通过菜单禁用');
    }
  }

  /**
   * 配置 WebSocket 端口
   */
  function configPort() {
    const currentPort = GM_getValue('port', Config.WS_URL.match(/:(\d+)$/)?.[1] || '51765');
    const input = prompt('请输入 WebSocket 端口号 (1-65535)：', currentPort);

    if (input === null) return; // 用户取消

    const trimmed = String(input).trim();
    const port = parseInt(trimmed, 10);

    if (Number.isFinite(port) && port >= 1 && port <= 65535) {
      GM_setValue('port', String(port));
      Config.WS_URL = `ws://localhost:${port}`;
      alert(`端口已设置为: ${port}\n配置已更新，WebSocket 将使用新端口。`);

      // 如果当前已启用，重新连接 WebSocket
      if (GM_getValue('enabled', false) && Transport.ws) {
        Transport.disconnect();
        Transport.connect();
      }
    } else {
      alert('无效的端口号！\n请输入 1-65535 之间的数字。');
    }
  }

  // ============================================
  // 初始化入口 (Task 7.2 - 阶段 1 改进)
  // ============================================
  let isInitialized = false; // 防止重复初始化

  /**
   * 初始化函数 - 状态机分层启动
   *
   * 基础层（常驻运行）：
   * - 读取持久化配置
   * - 注册油猴菜单命令
   *
   * 激活层（按需启用）：
   * - 根据配置决定是否激活 Inspector
   */
  function init() {
    if (isInitialized) {
      console.warn('[Web Inspector] 已初始化，跳过重复执行');
      return;
    }
    isInitialized = true;

    console.log('[Web Inspector] 脚本已加载');

    // ============================================
    // 基础层：始终执行
    // ============================================

    // 读取自定义端口配置
    const customPort = GM_getValue('port', null);
    if (customPort) {
      const port = parseInt(customPort, 10);
      if (Number.isFinite(port) && port >= 1 && port <= 65535) {
        Config.WS_URL = `ws://localhost:${port}`;
      } else {
        console.warn(`[Web Inspector] 无效的端口配置: ${customPort}，使用默认端口`);
        GM_setValue('port', null); // 清理无效配置
      }
    }

    // 注册油猴菜单命令
    GM_registerMenuCommand('切换 Web Inspector', toggleEnabled);
    GM_registerMenuCommand('设置 WebSocket 端口', configPort);

    // ============================================
    // 激活层：根据配置决定是否启用
    // ============================================

    const enabled = GM_getValue('enabled', false);
    if (enabled) {
      activateInspector();
    } else {
      console.log('[Web Inspector] 功能已禁用，点击油猴菜单"切换 Web Inspector"启用');
    }
  }

  // 启动脚本
  init();
})();
