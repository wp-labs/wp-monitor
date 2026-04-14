# WP Monitor 前端美化方案

## 一、当前状态分析

**技术栈**: React 18 + TypeScript + Ant Design v6 + ApexCharts + Vite

当前设计已具备基本的视觉体系（CSS 变量、卡片阴影、响应式布局），但在以下维度存在明显提升空间。

---

## 二、具体美化方向

### 1. 顶部标题栏 (`.title-wrap`)

**现状**: "WP MONITOR" 是无装饰的纯文字，与右侧工具栏之间缺少视觉层次。

**方案**:
- 给标题添加品牌颜色的左侧竖条装饰（`border-left: 4px solid #3b82f6`），形成视觉锚点
- 在标题下方增加副标题（如「日志流量实时监控」），字号 12px，颜色 `#64748b`
- 标题区域右侧与工具栏之间加一条 1px 分隔线（`border-right: 1px solid #e2e8f0`）
- 整个 `.title-wrap` 区域改为独立的顶部 bar，加浅色背景（`#ffffff`）+ 底部边框，使其具有"导航条"的感觉，而非悬浮在页面上

---

### 2. 实时刷新状态指示器

**现状**: 自动刷新状态仅通过 input 数字输入体现，没有"正在刷新"的视觉反馈。

**方案**:
- 在自动刷新 chip 内，数字前增加一个脉冲圆点（`@keyframes pulse`，绿色 `#22c55e`）代表"实时在线"
- 当 `autoRefreshEnabled` 为 false 时，圆点变为灰色静止状态
- 每次 `refreshMetricsOnly` 调用时触发一次短暂的旋转动画（`rotate 0.3s linear`）

---

### 3. 节点卡片 (`.node`, `.package`, `.group`, `.log-item`, `.sink-item`)

**现状**: 节点卡片基础视觉可以，但 hover/selected 的状态变化不够明显，指标数字直接以 `<br>` 换行。

**方案**:
- **Hover 动效**: 现有 `transform: translateY(-1px)` 效果良好，可叠加 `box-shadow` 从 `--shadow` 增强到 `0 8px 20px rgba(0,0,0,0.12)` 以强化立体感
- **选中态**: 选中节点增加左侧 4px 蓝色实心竖条（package 和 group 已有，但 `node`/`log-item`/`sink-item` 缺少）
- **指标排版**: 速率和计数改为横向排列的两个 badge，而非换行文字。用 `.metric-inline` 的方式展示，背景用半透明底色（如 `rgba(59,130,246,0.08)`）
- **节点名称**: `.node-name` 字号从 14px 提到 15px，增加 `letter-spacing: 0.2px` 提升可读性
- **MISS 节点**: `miss-alert` 状态时，增加闪烁边框动画（`@keyframes blink-border`，0.5s 周期，subtle）；`miss-muted` 状态保持静止，加 `opacity: 0.7` 淡化

---

### 4. 加载状态 (`<p>加载中...</p>`)

**现状**: 纯文字 "加载中..."，非常简陋。

**方案**:
- 替换为骨架屏（Skeleton Cards）：3 列布局中各显示 2-3 个灰色渐变矩形（使用 `@keyframes shimmer` 动画，左到右扫光效果）
- 颜色从 `#f1f5f9` 到 `#e2e8f0` 渐变扫光
- 高度与真实卡片近似，避免布局跳动（CLS）

---

### 5. 详情面板 (`.detail-panel`)

**现状**: 详情面板的头部比较朴素，拖拽条视觉不够明显。

**方案**:
- **拖拽条** `.detail-drag-handle`：宽度从 36px 增加到 48px，hover 时颜色从 `#94a3b8` 变为 `#3b82f6`（`cursor: ns-resize` 已存在，无需变动）
- **头部渐变背景** `.detail-panel-head`：当前 `linear-gradient(180deg, #f8fbff 0%, #f2f7ff 100%)` 轻微增加蓝色饱和度，改为 `linear-gradient(180deg, #f0f7ff 0%, #e8f2ff 100%)`
- **节点 Pill** `.detail-node-pill`：增加一个前缀色点 `"●"` 与节点类型对应（source 蓝、parse 紫、sink 天蓝）；需在 JSX 中给 pill 增加对应类名（如 `detail-node-pill--source`），再通过 CSS `::before` 设置颜色，单靠 CSS 无法感知节点类型
- **关闭按钮** `.drawer-close`：增加 hover 状态 `background: #fee2e2; color: #b91c1c`（红色警示），提升可发现性

---

### 6. 速率趋势图容器 (`.spark`)

**现状**: ApexCharts 图表容器背景为浅渐变，整体融合较好，但图表区域偏小（132px 高）。

**方案**:
- `.spark-chart` 默认高度从 132px 提到 160px，给图表更多呼吸空间

---

### 7. 工具栏按钮视觉统一

**现状**: `.mini-btn` 边框颜色 `#c8d2dc` 和背景 `#f6f9fb` 稍显发灰，不够清爽。

**方案**:
- `.mini-btn` 改为白底 + `#d1d9e8` 边框 + hover 时变 `#eff6ff` 背景 + `#2563eb` 边框，与整体蓝色主题统一
- 快速时间范围按钮（`.wd-time-quick-btn`）active 状态在现有 `font-weight: 700` 外，还加一个底部 2px 蓝色下划线 `border-bottom: 2px solid #2563eb`
- 查询按钮 `.btn-wow-primary` 的渐变角度从 135° 改为 160°，渐变结束色从 `#60a5fa` 改为 `#3b82f6`（使按钮颜色更稳定），hover 时加 `transform: translateY(-1px)` + shadow 增强

---

### 8. 错误 Toast 改进

**现状**: Toast 已有基本红色设计，但图标仅用 "!" 文字。

**方案**:
- 错误图标改为 SVG 警告三角（通过 CSS `clip-path` 实现或内联），比圆形 "!" 更符合警告语义
- 增加入场动画：从顶部 `translateY(-20px) + opacity: 0` 到正常位置，时长 `0.2s ease-out`（纯 CSS 可实现）
- 增加出场动画：反向淡出，时长 `0.15s`；注意当前通过 `setToastVisible(false)` 直接卸载，纯 CSS 无法拦截，需配合 JS 先触发 CSS `animation`、等动画结束后再清除 state（监听 `animationend` 事件）

---

### 9. 滚动条美化

**现状**: `.lane-scroll`、`.log-list`、`.sink-list` 等可滚动区域使用系统默认滚动条，macOS/Windows 风格不一。

**方案**（Webkit + Firefox 双端）:

```css
/* 全局滚动条统一样式 */
* {
    scrollbar-width: thin;
    scrollbar-color: #c1cad6 transparent;
}

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #c1cad6; border-radius: 999px; }
::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
```

---

### 10. 暗色模式支持（可选进阶）

**现状**: 无暗色模式，纯亮色设计。

**方案**:
- 通过 `@media (prefers-color-scheme: dark)` 重新定义 CSS 变量：
  - `--page-bg: #0f172a`
  - `--card-bg: #1e293b`
  - `--text-main: #f1f5f9`
  - `--text-sub: #94a3b8`
  - 各 lane 的 package/group/miss 边框色对应调暗
- Ant Design 通过 `ConfigProvider` 传入 `theme: { algorithm: theme.darkAlgorithm }` 实现组件暗化

---

## 三、优先级建议

| 优先级 | 项目 | 改动量 | 视觉收益 |
|--------|------|--------|----------|
| P0 高  | 滚动条统一 + 骨架屏加载 | 小 | 中 |
| P0 高  | 节点卡片选中/hover 细化 | 小 | 高 |
| P1 中  | 实时刷新脉冲指示器 | 小 | 中 |
| P1 中  | 标题栏 + 副标题 | 小 | 高 |
| P1 中  | 工具栏按钮视觉统一 | 小 | 中 |
| P2 低  | 详情面板头部优化 | 小 | 中 |
| P2 低  | 错误 Toast 动画 | 小 | 中 |
| P3 可选| 暗色模式 | 大 | 高 |

所有方案均**不涉及组件结构重构**，主要通过 CSS 变量扩展、新增 CSS 规则、少量 JSX 结构调整即可实现，风险可控。