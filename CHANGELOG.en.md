# Changelog

All notable changes are documented in this file, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
with version numbers adhering to [Semantic Versioning](https://semver.org/).

## [1.0.4] - 2026-07-15

### Added

- Return `layer_versions` from `/layers/metrics` so the frontend can automatically detect node topology changes and trigger a full snapshot reload.

## [1.0.3] - 2026-07-14

### Fixed

- Fix issue where the silent log type could not be selected in the search box.

## [1.0.2] - 2026-07-13

### Fixed

- Fix issue where the selected node was not displayed in the search box.
- Fix empty alert trend chart caused by VM `rate()` returning zeros for sparse counters.

## [1.0.1] - 2026-07-08

### Added

- i18n support for wfusion engine monitoring panel.
- Replace ApexCharts with ECharts, redesign chart palettes.
- Runtime miss source switching (vlog/file) without page refresh.
- Chart Y-axis and fullscreen interaction improvements.
- Add `build.rs` for auto frontend build.
- Persist chart legend state.

### Changed

- Centralize miss query sorting in repo layer, returning records newest-first.
- Unify stat window metric semantics.

### Fixed

- Fix React 19 type error with WfMonitor timer ref.
- Fix `metric_mode` parameter and restore light-modern theme.
- Fix Y-axis label duplication and filter silent chart series.
- Extract shared VM utilities to reduce code duplication.
- Fix frontend trend chart rendering issues.

## [0.8.6] - 2026-07-03

### Fixed

- Fix frontend compilation errors.

## [0.8.5] - 2026-07-03

### Fixed

- Fix time window bug.

## [0.8.4] - 2026-07-02

### Changed

- Interface optimization.

## [0.8.2] - 2026-07-02

### Added

- Fix time series correction for monitoring details and improve time window interaction.
- Add count trend chart.
- Fix MISS data display in fullscreen mode.

### Changed

- Change "this week" time option to "last 7 days".

## [0.8.1] - 2026-06-30

### Fixed

- Fix time refresh linkage between wp-monitor and monitoring panel state.

## [0.8.0] - 2026-06-29

### Added

- Add source count badge display.
- Add node detail fullscreen mode.

## [0.7.7] - 2026-06-25

### Fixed

- Eliminate trend chart flicker and loading flash during auto-refresh.

## [0.7.6] - 2026-06-25

### Added

- Add wfusion engine monitoring interface.

### Fixed

- Improve MISS data display, time range UX, and detail panel sync.

## [0.7.5] - 2026-06-09

### Changed

- Switch MISS logs to client-side pagination with unified export, simplifying frontend-backend interaction.

## [0.7.4] - 2026-05-22

### Changed

- Version bump, no functional changes.

## [0.7.3] - 2026-05-19

### Added

- Add file-based reading mode for MISS logs with increased file reading channels for better performance in large-file log replay scenarios.

### Changed

- Compact frontend layout with reduced spacing for higher information density.
- Align parse layer node list horizontally, fixing visual misalignment with side panels.

### Fixed

- Remove chart title and update tooltip style for rate trend chart.
- Update chart tooltip border style.
- Fix TypeScript compilation warnings (unused variables, JSX tag mismatch causing build failure).

## [0.7.2] - 2026-05-15

### Added

- Add `filters` parameter to `/layers/metrics` endpoint for filtering parse-layer metrics by package/rule combinations.
- Add `filterLogsByMode` frontend helper to unify log filtering logic for "withData/noData" modes.
- Add `resolveTimeRange` frontend helper to eliminate duplicated time range validation code.

### Changed

- Change `/layers/metrics` from GET to POST with JSON body for parameter passing.
- Refactor `fetchMetrics`, `fetchPackagesTimeSeries`, `fetchParseTimeSeries` to use structured filters instead of raw node_ids.
- Switch parse filter criteria from `log_count` to `log_rate_eps` for consistent metric semantics.
- Consolidate regex escaping to `escape_regex_chars`, remove duplicate `escape_promql_regex`.
- Replace inline regex escaping in `get_parse_timeseries` with `escape_regex_chars` calls.

### Fixed

- Fix filter loop overwrite bug in `fetch_snapshot_data` where only the last filter was applied.
- Fix cache zero-fill oscillation in frontend "noData" mode when filters are active.

### Removed

- Remove `zeroSeriesForSilent` frontend workaround (no longer needed with proper backend filtering).
- Remove duplicate `escape_promql_regex` method in favor of `escape_regex_chars`.

## [0.7.1] - 2026-05-12

### Changed

- Refactor error handling for unified error response format and propagation.
- Bump version to 0.7.2.

## [0.7.0] - 2026-05-11

### Added

- Add Helm chart packaging support.
