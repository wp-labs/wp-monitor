# 前端改造实施文档

本文档描述基于 `dev_doc/ParseNodeOptimization.md` 功能需求，对 `frontend/` 进行的具体代码改动。交互原型参考 `dev_doc/wp-monitor-proto.html`。

---

## 改动概览

| # | 改动项 | 涉及文件 | 影响范围 |
|---|--------|----------|----------|
| 1 | Miss 节点迁移 | `index.tsx` | JSX 结构调整 |
| 2 | 数据过滤器（活跃/静默） | `index.tsx` | 新增状态 + UI + 过滤逻辑 |
| 3 | Parse 分页 | `index.tsx` + `flowHelpers.ts` | 新增分页状态 + 分页计算 + UI |
| 4 | Parse 标题 → Package 趋势图 | `monitor.ts` + `index.tsx` + `ScopeTrendPanel.tsx` | 新增 API + 图表模式切换 |
| 5 | Package 点击 → Log 趋势图 | `index.tsx` | JSX onclick 调整 |
| 6 | 默认打开趋势图 | `index.tsx` | useEffect 添加初始化调用 |
| 7 | 静默模式零值曲线 | `TimeSeriesChart.tsx` + `ScopeTrendPanel.tsx` | 图表渲染判断 |

---

## 1. Miss 节点迁移

**文件**: `frontend/src/views/pages/wp-monitor/index.tsx`

### 当前状态（行 1390-1409）

Miss 节点在 Parse 列 `<div className="lane-scroll">` 的底部，紧跟在 `snapshot.parses.map(...)` 之后。

### 改动

将 Miss 节点的 JSX 从 Parse 列的 `lane-scroll` 内部剪切，粘贴到 Sink 列（输出层）的 `lane-scroll` 内部、sink group 列表**之前**。

**具体步骤**:
1. 找到 Sink 列 JSX（约行 1413 附近的 `<section className="lane">`）
2. 在 Sink 的 `<div className="lane-scroll">` 内部、`snapshot.sinks.map(...)` 之前，插入 Miss 节点
3. Miss 节点样式不变，使用 `node--miss` 类

**示例代码位置**:
```
Sink lane-scroll 内:
  <article className="node node--miss ...">  ← 移到此处（sink group 列表上方）
    ...
  </article>
  {snapshot.sinks.map(...)}  ← 原有 sink group 列表
```

---

## 2. 数据过滤器（活跃 / 静默）

**文件**: `frontend/src/views/pages/wp-monitor/index.tsx`

### 新增状态

```typescript
const [parseFilter, setParseFilter] = useState<'withData' | 'noData'>('withData');
```

### 新增 UI

在 Parse 列的 `lane-head` 下方、`lane-scroll` 上方插入过滤按钮组：

```tsx
<div className="filter-bar">
  <Button
    size="small"
    type={parseFilter === 'withData' ? 'primary' : 'default'}
    onClick={() => { setParseFilter('withData'); setParsePage(1); }}
  >
    活跃
  </Button>
  <Button
    size="small"
    type={parseFilter === 'noData' ? 'primary' : 'default'}
    onClick={() => { setParseFilter('noData'); setParsePage(1); }}
  >
    静默
  </Button>
</div>
```

### 过滤逻辑

对 `snapshot.parses` 做前端过滤，替换现有 `snapshot.parses.map(...)` 中的直接遍历：

```typescript
const filteredParses = useMemo(() => {
  return snapshot.parses.filter(p => {
    if (parseFilter === 'withData') return p.metrics.log_count > 0;
    if (parseFilter === 'noData') return p.metrics.log_count === 0;
    return true;
  });
}, [snapshot.parses, parseFilter]);
```

Package 内部的 log 列表也需要同样过滤：

```typescript
const showLogs = parseFilter === 'withData'
  ? p.logs.filter(l => l.metrics.log_count > 0)
  : p.logs;
```

### 切换过滤器时的副作用

在 `setParseFilter` 的调用处，需要同步处理：
- 分页重置为第 1 页
- 如果 detail panel 已打开且为 scope 模式，重新触发数据请求刷新图表

---

## 3. Parse 分页

**文件**: 
- `frontend/src/views/pages/wp-monitor/index.tsx`
- `frontend/src/views/components/monitor/flowHelpers.ts`

### 分页算法（新增到 flowHelpers.ts）

```typescript
/**
 * 按 log 数量分页，package 不可拆分。
 * 返回 pages: ParseNode[][] 
 */
export function buildLogPages(
  parses: ParseNode[],
  pageSize: number,
  filterFn: (log: LogTypeNode) => boolean,
): ParseNode[][] {
  const pages: ParseNode[][] = [];
  let current: ParseNode[] = [];
  let currentCount = 0;

  for (const pkg of parses) {
    const logCount = pkg.logs.filter(filterFn).length;
    if (currentCount + logCount > pageSize && current.length > 0) {
      pages.push(current);
      current = [];
      currentCount = 0;
    }
    current.push(pkg);
    currentCount += logCount;
  }
  if (current.length > 0) pages.push(current);
  return pages.length > 0 ? pages : [[]];
}
```

### 新增状态

```typescript
const PARSE_PAGE_SIZE = 10;
const [parsePage, setParsePage] = useState(1);
```

### 分页计算

```typescript
const filteredParses = ... ; // 来自过滤逻辑
const pages = useMemo(
  () => buildLogPages(filteredParses, PARSE_PAGE_SIZE, (log) => {
    if (parseFilter === 'withData') return log.metrics.log_count > 0;
    return true;
  })),
  [filteredParses, parseFilter]
);
const totalPages = pages.length;
const pageItems = pages[Math.min(parsePage - 1, totalPages - 1)] || [];
```

### 分页器 UI（Parse 列底部）

```tsx
{totalPages > 1 && (
  <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '8px 0' }}>
    <Button size="small" disabled={parsePage <= 1} onClick={() => setParsePage(p => p - 1)}>
      ◀
    </Button>
    <span style={{ fontSize: 12, color: 'var(--text-sub)' }}>
      {parsePage} / {totalPages} 页
    </span>
    <Button size="small" disabled={parsePage >= totalPages} onClick={() => setParsePage(p => p + 1)}>
      ▶
    </Button>
  </div>
)}
```

### JSX 渲染

将 `snapshot.parses.map(...)` 改为 `pageItems.map(...)`。

### 默认展开

保持现有的默认全部展开逻辑（`setExpandedPackages(data.parses.map(p => p.id))`）。

---

## 4. Parse 标题 → Package 趋势图

**文件**:
- `frontend/src/services/monitor.ts` — 新增 API 函数
- `frontend/src/views/pages/wp-monitor/index.tsx` — 修改点击逻辑

### 4.1 新增后端 API 调用

当前 `fetchParseTimeSeries` 按 scope 返回所有匹配的节点时序数据，但没有 `package_ids` 参数来精确指定包。

**方案**：复用现有 `fetchParseTimeSeries`，在 Parse scope 下不传 `package_name` 时返回全部 package 的数据。如果后端需要支持按 package ID 批量查询，则新增参数。

前端新增函数：

```typescript
/** 获取所有 package 的汇总时序数据（不含 log 级别） */
export async function fetchPackageTimeSeries(
  startTime: string,
  endTime: string,
  maxDataPoints?: number,
) {
  return fetchParseTimeSeries('parse', startTime, endTime, maxDataPoints);
}
```

如果后端需要在 parse 节点查询中区分「package 级别」和「log 级别」，则新增 scope 枚举值或参数。详见后端改动文档。

### 4.2 修改 Parse 标题点击行为

当前 Parse 标题点击调用:
```typescript
openParseTimeseries('parse', '__parse__', 'Parse 层全部节点趋势')
```

改为调用新函数，传入 `scopeMode: 'package'` 标记：

```typescript
const handleParseTitleClick = async () => {
  setDetailViewMode('scope');
  setScopeMode('package'); // 新增状态
  setSelectedNode('__parse__');
  // 请求数据
  const resp = await fetchPackageTimeSeries(startTime, endTime, estimateMaxDataPoints());
  setParseSeriesList(resp.data);
  // ...
};
```

### 4.3 新增状态

```typescript
type ScopeMode = 'log' | 'package';
const [scopeMode, setScopeMode] = useState<ScopeMode>('log');
```

### 4.4 图例颜色

在 package 模式下，图例使用 normal scopeColors 循环，不做 tier 着色。

---

## 5. Package 名称点击 → Log 趋势图

**文件**: `frontend/src/views/pages/wp-monitor/index.tsx`

### 改动

Package 名称区域增加 `onClick` 打开该 package 下所有 log 的趋势图，▼ 箭头独立处理展开/折叠。

```tsx
<section className="node node--package ...">
  <div className="node__header">
    {/* 名称区域 — 点击打开趋势 */}
    <div
      onClick={(e) => { e.stopPropagation(); openParseTimeseries('parse', p.id, `Package ${p.package_name} 节点趋势`, p.package_name); }}
      style={{ cursor: 'pointer', flex: 1 }}
    >
      <div className="node__title">{p.package_name}</div>
      <div className="node__summary">...</div>
    </div>
    {/* Chevron — 点击展开/折叠 */}
    <Button
      size="small" type="text"
      icon={<ChevronDown ... />}
      onClick={(e) => { e.stopPropagation(); togglePackage(p.id); }}
    />
  </div>
  ...
</section>
```

需要将 `openScope` 函数中 `scopeMode` 设为 `'log'`，以区分 package 模式和 log 模式。

---

## 6. 默认打开趋势图

**文件**: `frontend/src/views/pages/wp-monitor/index.tsx`

在 `loadSnapshot` 完成后的 `useEffect` 中，数据首次加载成功后自动触发：

```typescript
useEffect(() => {
  if (snapshot && !initialScopeOpened.current) {
    initialScopeOpened.current = true;
    // 默认打开 Parse 层 package 趋势图
    handleParseTitleClick();
  }
}, [snapshot]);
```

新增 ref: `const initialScopeOpened = useRef(false);`

---

## 7. 静默模式零值曲线

**文件**:
- `frontend/src/views/components/monitor/ScopeTrendPanel.tsx`
- `frontend/src/views/components/monitor/TimeSeriesChart.tsx`

### ScopeTrendPanel 改动

当 `parseFilter === 'noData'` 时，图例显示正常，但所有曲线的 Y 值均为 0，图表区域渲染为底部平直线。

可以通过 `parseFilter` props 传入 ScopeTrendPanel，当为 `'noData'` 时，对 `parseMultiSeries` 做特殊处理：所有 `log_rate_eps` 点的 `value` 设为 0。

### TimeSeriesChart 改动

当所有数据点 value 均为 0 时，Y 轴范围应设为 `[0, 1]`（避免显示负数），曲线渲染为 `y=0` 的平直线。

或者在前端数据层面处理：在 scope 模式下且 `parseFilter === 'noData'` 时，不发起后端请求，直接构造全零的 mock 数据数组（对应用户看到的全零平直线）。

---

## 8. 清理项

### 移除不再需要的 checkbox 相关代码

如果当前代码中存在任何 log 级别选择框逻辑，全部移除。

### 移除 EPS 分层筛选相关代码

如果当前代码中存在层级筛选 UI 或逻辑，全部移除。

---

## 改动文件清单

| 文件 | 改动类型 |
|------|----------|
| `src/views/pages/wp-monitor/index.tsx` | 主要改动：过滤器、分页、JSX 调整、默认打开、Miss 迁移 |
| `src/views/pages/wp-monitor/index.css` | 新增 filter-bar 样式 |
| `src/services/monitor.ts` | 可能新增 package 级别 API 函数 |
| `src/types/monitor.ts` | 可能新增类型（scopeMode 等） |
| `src/views/components/monitor/flowHelpers.ts` | 新增 `buildLogPages` 工具函数 |
| `src/views/components/monitor/ScopeTrendPanel.tsx` | 支持 package/log 模式切换 + 静默零值 |
| `src/views/components/monitor/TimeSeriesChart.tsx` | 支持全零数据渲染 |

---

## 参考

- 交互原型: `dev_doc/wp-monitor-proto.html`
- 功能需求文档: `dev_doc/ParseNodeOptimization.md`
- 后端改动文档: `backend/dev_doc/BackendChanges.md`
