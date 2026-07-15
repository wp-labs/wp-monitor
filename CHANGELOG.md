# Changelog

本文件记录所有重要变更，格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

All notable changes are documented in this file, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
with version numbers adhering to [Semantic Versioning](https://semver.org/).

## [1.0.4] - 2026-07-15

### Added

- 指标增量刷新接口 `/layers/metrics` 返回 `layer_versions`，前端自动检测节点拓扑变化（新增/移除节点）并触发全量快照刷新。

- Return `layer_versions` from `/layers/metrics` so the frontend can automatically detect node topology changes and trigger a full snapshot reload.

## [1.0.3] - 2026-07-14

### Fixed

- 修复静默日志类型在搜索框中无法选中的问题。

- Fix issue where the silent log type could not be selected in the search box.

## [1.0.2] - 2026-07-13

### Fixed

- 修复搜索框中选中节点未回显的问题。
- 修复 VM `rate()` 对稀疏计数器返回零值导致告警趋势图为空的问题。

- Fix issue where the selected node was not displayed in the search box.
- Fix empty alert trend chart caused by VM `rate()` returning zeros for sparse counters.

## [1.0.1] - 2026-07-08

### Added

- Wfusion 引擎监控面板国际化支持。
- 图表库从 ApexCharts 迁移至 ECharts，重新设计图表调色板。
- 支持运行时切换 MISS 数据源（vlog/file），无需刷新页面。
- 图表 Y 轴和全屏模式交互优化。
- 新增 `build.rs` 支持前端自动构建。
- 图表图例状态持久化。

- i18n support for wfusion engine monitoring panel.
- Replace ApexCharts with ECharts, redesign chart palettes.
- Runtime miss source switching (vlog/file) without page refresh.
- Chart Y-axis and fullscreen interaction improvements.
- Add `build.rs` for auto frontend build.
- Persist chart legend state.

### Changed

- MISS 查询排序逻辑统一收敛至 repo 层，返回结果按最新优先排列。
- 统计窗口指标口径统一。

- Centralize miss query sorting in repo layer, returning records newest-first.
- Unify stat window metric semantics.

### Fixed

- 修复 React 19 类型错误（WfMonitor timer ref）。
- 修复 `metric_mode` 参数问题，恢复 light-modern 主题。
- 修复 Y 轴标签重复问题，过滤静默图表系列。
- 提取共享 VM 工具函数以减少重复代码。
- 修复前端趋势图渲染问题。

- Fix React 19 type error with WfMonitor timer ref.
- Fix `metric_mode` parameter and restore light-modern theme.
- Fix Y-axis label duplication and filter silent chart series.
- Extract shared VM utilities to reduce code duplication.
- Fix frontend trend chart rendering issues.

## [0.8.6] - 2026-07-03

### Fixed

- 修复前端编译错误。

- Fix frontend compilation errors.

## [0.8.5] - 2026-07-03

### Fixed

- 修复时间窗口相关 bug。

- Fix time window bug.

## [0.8.4] - 2026-07-02

### Changed

- 界面交互优化。

- Interface optimization.

## [0.8.2] - 2026-07-02

### Added

- 监控详情时序修正，优化时间窗口交互体验。
- 新增数量趋势图。
- 修复全屏模式下 MISS 数据显示问题。

- Fix time series correction for monitoring details and improve time window interaction.
- Add count trend chart.
- Fix MISS data display in fullscreen mode.

### Changed

- 监控时间"本周"选项改为"最近 7 天"。

- Change "this week" time option to "last 7 days".

## [0.8.1] - 2026-06-30

### Fixed

- 修复 wp-monitor 与监控面板状态时间刷新联动问题。

- Fix time refresh linkage between wp-monitor and monitoring panel state.

## [0.8.0] - 2026-06-29

### Added

- 新增 source 数量徽章显示。
- 新增节点详情全屏模式。

- Add source count badge display.
- Add node detail fullscreen mode.

## [0.7.7] - 2026-06-25

### Fixed

- 消除自动刷新期间趋势图闪烁与加载闪烁问题。

- Eliminate trend chart flicker and loading flash during auto-refresh.

## [0.7.6] - 2026-06-25

### Added

- 新增 wfusion 引擎监控界面。

- Add wfusion engine monitoring interface.

### Fixed

- 改进 MISS 数据显示、时间范围交互体验及详情面板同步问题。

- Improve MISS data display, time range UX, and detail panel sync.

## [0.7.5] - 2026-06-09

### Changed

- MISS 日志改为客户端分页，统一导出接口，简化前后端交互逻辑。

- Switch MISS logs to client-side pagination with unified export, simplifying frontend-backend interaction.

## [0.7.4] - 2026-05-22

### Changed

- 版本号迭代，无功能变更。

- Version bump, no functional changes.

## [0.7.3] - 2026-05-19

### Added

- MISS 日志新增文件读取模式，支持大文件场景下的日志回放，增加文件读取通道以提升性能。

- Add file-based reading mode for MISS logs with increased file reading channels for better performance in large-file log replay scenarios.

### Changed

- 前端布局紧凑化，缩减各区域间距，提升信息密度。
- Parse 层节点列表横向对齐，修复与两侧面板不对齐的视觉问题。

- Compact frontend layout with reduced spacing for higher information density.
- Align parse layer node list horizontally, fixing visual misalignment with side panels.

### Fixed

- 移除速率趋势图标题并优化 tooltip 样式。
- 更新图表 tooltip 边框样式。
- 修复 TypeScript 编译警告（未使用变量、JSX 标签不匹配导致构建失败）。

- Remove chart title and update tooltip style for rate trend chart.
- Update chart tooltip border style.
- Fix TypeScript compilation warnings (unused variables, JSX tag mismatch causing build failure).

## [0.7.2] - 2026-05-15

### Added

- `/layers/metrics` 接口新增 `filters` 参数，支持按 package/rule 组合过滤 parse 层指标数据。
- 新增 `filterLogsByMode` 前端工具函数，统一 "活跃/静默" 模式的日志过滤逻辑。
- 新增 `resolveTimeRange` 前端工具函数，消除时间范围校验的重复代码。

- Add `filters` parameter to `/layers/metrics` endpoint for filtering parse-layer metrics by package/rule combinations.
- Add `filterLogsByMode` frontend helper to unify log filtering logic for "withData/noData" modes.
- Add `resolveTimeRange` frontend helper to eliminate duplicated time range validation code.

### Changed

- `/layers/metrics` 接口从 GET 改为 POST，参数改为 JSON body 传递。
- 前端 `fetchMetrics`、`fetchPackagesTimeSeries`、`fetchParseTimeSeries` 重构为使用结构化 filters 替代原始 node_ids。
- Parse 层过滤判断从 `log_count` 改为 `log_rate_eps`，统一指标口径。
- 后端统一使用 `escape_regex_chars`，移除重复的 `escape_promql_regex` 方法。
- `get_parse_timeseries` 中的内联正则转义替换为调用 `escape_regex_chars`。

- Change `/layers/metrics` from GET to POST with JSON body for parameter passing.
- Refactor `fetchMetrics`, `fetchPackagesTimeSeries`, `fetchParseTimeSeries` to use structured filters instead of raw node_ids.
- Switch parse filter criteria from `log_count` to `log_rate_eps` for consistent metric semantics.
- Consolidate regex escaping to `escape_regex_chars`, remove duplicate `escape_promql_regex`.
- Replace inline regex escaping in `get_parse_timeseries` with `escape_regex_chars` calls.

### Fixed

- 修复 `fetch_snapshot_data` 中 filter 循环覆盖 bug，多个 filter 时仅最后一个生效。
- 修复 filter 存在时缓存填零导致前端 "静默" 模式数据震荡的问题。

- Fix filter loop overwrite bug in `fetch_snapshot_data` where only the last filter was applied.
- Fix cache zero-fill oscillation in frontend "noData" mode when filters are active.

### Removed

- 移除前端 `zeroSeriesForSilent` 函数（后端正确过滤后不再需要）。
- 移除 `vm_repository.rs` 中与 `escape_regex_chars` 重复的 `escape_promql_regex` 方法。

- Remove `zeroSeriesForSilent` frontend workaround (no longer needed with proper backend filtering).
- Remove duplicate `escape_promql_regex` method in favor of `escape_regex_chars`.

## [0.7.1] - 2026-05-12

### Changed

- 错误处理机制重构，统一错误响应格式与透传逻辑。
- 更新版本号至 0.7.2。

- Refactor error handling for unified error response format and propagation.
- Bump version to 0.7.2.

## [0.7.0] - 2026-05-11

### Added

- 新增 Helm Chart 打包支持。

- Add Helm chart packaging support.
