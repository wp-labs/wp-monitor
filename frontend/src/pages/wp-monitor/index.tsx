import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyMetricsToSnapshot,
  collectAllNodeIds,
  fmtCount,
  fmtRate,
} from '../../components/monitor/flowHelpers';
import TimeSeriesChart from '../../components/monitor/TimeSeriesChart';
import {
  fetchMissedLogs,
  fetchMetrics,
  fetchNodeDetail,
  fetchNodeTimeSeries,
  fetchSnapshot,
} from '../../services/monitor';
import type { LayerSnapshot, NodeDetail, NodeTimeSeries, VlogRecord } from '../../types/monitor';
import './index.css';

const QUICK_RANGES = [
  { key: '5m', label: '最近 5 分钟', minutes: 5 },
  { key: '15m', label: '最近 15 分钟', minutes: 15 },
  { key: '1h', label: '最近 1 小时', minutes: 60 },
  { key: '6h', label: '最近 6 小时', minutes: 360 },
  { key: '24h', label: '最近 24 小时', minutes: 1440 },
] as const;
const MISS_PAGE_SIZE = 10;

type LegendType = 'source' | 'package' | 'log' | 'group' | 'sink' | 'miss' | null;
type ParseSearchItem =
  | { key: string; type: 'package'; packageId: string; packageName: string; label: string }
  | {
      key: string;
      type: 'log';
      packageId: string;
      packageName: string;
      logId: string;
      logName: string;
      label: string;
    };

function toIsoByMinutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function toInputValue(iso: string) {
  const d = new Date(iso);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function toIsoFromInput(v: string) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function formatLocalDateTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatLocalTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export default function WpMonitorPage() {
  const formatCount = useCallback((v: number) => fmtCount(v), []);
  const formatCountAxis = useCallback((v: number) => new Intl.NumberFormat('zh-CN').format(Math.round(v)), []);
  const formatRate2 = useCallback((v: number) => `${v.toFixed(2)} e/s`, []);

  const [snapshot, setSnapshot] = useState<LayerSnapshot | null>(null);
  const [startTime, setStartTime] = useState(() => toIsoByMinutesAgo(15));
  const [endTime, setEndTime] = useState(() => new Date().toISOString());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [selectedNode, setSelectedNode] = useState('');
  const [hoveredNode, setHoveredNode] = useState('');
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [series, setSeries] = useState<NodeTimeSeries | null>(null);
  const [detailStartTime, setDetailStartTime] = useState('');
  const [detailEndTime, setDetailEndTime] = useState('');
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState('');
  const [missLogsLoading, setMissLogsLoading] = useState(false);
  const [missLogsError, setMissLogsError] = useState('');
  const [missLogs, setMissLogs] = useState<VlogRecord[]>([]);
  const [missQueryLimit, setMissQueryLimit] = useState(10);
  const [missLimitInput, setMissLimitInput] = useState('10');
  const [missPage, setMissPage] = useState(1);

  const [expandedPackages, setExpandedPackages] = useState<string[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);

  const [timePanelOpen, setTimePanelOpen] = useState(false);
  const [draftRange, setDraftRange] = useState('15m');
  const [draftStart, setDraftStart] = useState(() => toInputValue(toIsoByMinutesAgo(15)));
  const [draftEnd, setDraftEnd] = useState(() => toInputValue(new Date().toISOString()));
  const [rangeLabel, setRangeLabel] = useState('最近 15 分钟');
  const timePickerRef = useRef<HTMLDivElement | null>(null);

  const [activeLegend, setActiveLegend] = useState<LegendType>(null);
  const [parseQuery, setParseQuery] = useState('');
  const [parseSearchOpen, setParseSearchOpen] = useState(false);
  const [parseSearchActiveIndex, setParseSearchActiveIndex] = useState(0);
  const parseSearchRef = useRef<HTMLDivElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);

  async function loadSnapshot(start = startTime, end = endTime) {
    try {
      setLoading(true);
      setError('');
      const data = await fetchSnapshot(start, end);
      setSnapshot(data);
      setExpandedPackages(data.parses.map((p) => p.id));
      setExpandedGroups(data.sinks.map((g) => g.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshMetricsOnly() {
    if (!snapshot || selectedNode) return;
    try {
      const ids = collectAllNodeIds(snapshot);
      const data = await fetchMetrics(startTime, new Date().toISOString(), ids);
      setSnapshot((prev) => (prev ? applyMetricsToSnapshot(prev, data.items) : prev));
      setEndTime(new Date().toISOString());
    } catch {
      await loadSnapshot();
    }
  }

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    if (selectedNode) return;
    const timer = setInterval(() => {
      void refreshMetricsOnly();
    }, 5000);
    return () => clearInterval(timer);
  }, [snapshot, startTime, selectedNode]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (!timePickerRef.current?.contains(target)) setTimePanelOpen(false);
      if (!parseSearchRef.current?.contains(target)) setParseSearchOpen(false);
      if (
        selectedNode &&
        !drawerRef.current?.contains(target) &&
        !(target as Element).closest('.node, .package, .group, .log-item, .sink-item, .miss')
      ) {
        setSelectedNode('');
      }
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [selectedNode]);

  const nodesCount = useMemo(() => {
    if (!snapshot) return 0;
    const parseLogs = snapshot.parses.reduce((acc, p) => acc + p.logs.length, 0);
    const sinks = snapshot.sinks.reduce((acc, s) => acc + s.sinks.length, 0);
    return snapshot.sources.length + snapshot.parses.length + parseLogs + snapshot.sinks.length + sinks + 1;
  }, [snapshot]);

  const rateChartPoints = useMemo(() => series?.log_rate_eps ?? [], [series?.log_rate_eps]);
  const isMissSelected = useMemo(
    () => Boolean(snapshot && selectedNode && selectedNode === snapshot.miss.id),
    [snapshot, selectedNode],
  );
  const missTotalPages = useMemo(() => Math.max(1, Math.ceil(missLogs.length / MISS_PAGE_SIZE)), [missLogs.length]);
  const missPageItems = useMemo(() => {
    const page = Math.min(Math.max(missPage, 1), missTotalPages);
    const start = (page - 1) * MISS_PAGE_SIZE;
    return missLogs.slice(start, start + MISS_PAGE_SIZE);
  }, [missLogs, missPage, missTotalPages]);

  const parseSearchGroups = useMemo(() => {
    if (!snapshot) return [];
    const q = parseQuery.trim().toLowerCase();
    if (!q) return [];
    return snapshot.parses
      .map((p) => {
        const pkgMatched = p.package_name.toLowerCase().includes(q);
        const logsMatched = p.logs.filter((l) => l.name.toLowerCase().includes(q));
        if (!pkgMatched && logsMatched.length === 0) return null;
        return { pkg: p, logsMatched };
      })
      .filter(Boolean) as Array<{
      pkg: LayerSnapshot['parses'][number];
      logsMatched: LayerSnapshot['parses'][number]['logs'];
    }>;
  }, [snapshot, parseQuery]);

  const parseSearchFlatItems = useMemo(() => {
    const list: ParseSearchItem[] = [];
    parseSearchGroups.forEach((g) => {
      list.push({
        key: `pkg:${g.pkg.id}`,
        type: 'package',
        packageId: g.pkg.id,
        packageName: g.pkg.package_name,
        label: `${g.pkg.package_name} package ${g.logsMatched.length ? `(${g.logsMatched.length})` : ''}`,
      });
      g.logsMatched.forEach((l) => {
        list.push({
          key: `log:${l.id}`,
          type: 'log',
          packageId: g.pkg.id,
          packageName: g.pkg.package_name,
          logId: l.id,
          logName: l.name,
          label: `${g.pkg.package_name} log_type ${l.name}`,
        });
      });
    });
    return list;
  }, [parseSearchGroups]);

  useEffect(() => {
    setParseSearchActiveIndex(0);
  }, [parseQuery, parseSearchOpen]);

  useEffect(() => {
    if (missPage > missTotalPages) {
      setMissPage(missTotalPages);
    }
  }, [missPage, missTotalPages]);

  function isDim(type: Exclude<LegendType, null>) {
    return activeLegend !== null && activeLegend !== type;
  }

  function nodeClass(base: string, nodeId: string, type: Exclude<LegendType, null>) {
    const classes = [base];
    if (isDim(type)) classes.push('dim');
    if (selectedNode === nodeId) classes.push('selected');
    if (hoveredNode === nodeId) classes.push('active');
    return classes.join(' ');
  }

  function normalizeMissLimit(value: number) {
    return Math.max(1, Math.min(100, Math.floor(value || 10)));
  }

  async function loadMissedLogs(start: string, end: string, limit: number, resetPage = true) {
    try {
      setMissLogsLoading(true);
      setMissLogsError('');
      const data = await fetchMissedLogs(start, end, limit);
      setMissLogs(data);
      if (resetPage) {
        setMissPage(1);
      }
      return data;
    } catch (e) {
      setMissLogs([]);
      setMissLogsError((e as Error).message || 'MISS 日志获取失败');
      return null;
    } finally {
      setMissLogsLoading(false);
    }
  }

  async function onApplyMissLimit() {
    if (!isMissSelected) return;
    const parsed = normalizeMissLimit(Number(missLimitInput));
    setMissLimitInput(String(parsed));
    setMissQueryLimit(parsed);
    await loadMissedLogs(detailStartTime, detailEndTime, parsed);
  }

  async function onPrevMissPage() {
    setMissPage((p) => Math.max(1, p - 1));
  }

  async function onNextMissPage() {
    const wantedPage = missPage + 1;
    if (wantedPage <= missTotalPages) {
      setMissPage(wantedPage);
      return;
    }

    const canExpandLimit = missQueryLimit < 100 && missLogs.length >= missQueryLimit;
    if (!canExpandLimit) return;

    const nextLimit = normalizeMissLimit(Math.min(100, missQueryLimit + MISS_PAGE_SIZE));
    setMissLimitInput(String(nextLimit));
    setMissQueryLimit(nextLimit);
    const data = await loadMissedLogs(detailStartTime, detailEndTime, nextLimit, false);
    if (data && data.length > (wantedPage - 1) * MISS_PAGE_SIZE) {
      setMissPage(wantedPage);
    }
  }

  async function openDetail(nodeId: string) {
    const missNodeId = snapshot?.miss.id ?? '';
    const isMissNode = nodeId === missNodeId;
    const currentStart = startTime;
    const currentEnd = new Date().toISOString();
    setSelectedNode(nodeId);
    setDetailStartTime(currentStart);
    setDetailEndTime(currentEnd);
    setDrawerLoading(true);
    setDrawerError('');
    setDetail(null);
    setSeries(null);
    setMissLogs([]);
    setMissLogsError('');
    setMissLogsLoading(false);
    try {
      const detailPromise = fetchNodeDetail(nodeId, currentStart, currentEnd);
      const seriesPromise = fetchNodeTimeSeries(nodeId, currentStart, currentEnd, '30s');
      if (isMissNode) {
        setMissLogsLoading(true);
        const [detailResp, seriesResp, missedResp] = await Promise.all([
          detailPromise,
          seriesPromise,
          fetchMissedLogs(currentStart, currentEnd, missQueryLimit),
        ]);
        setMissLogs(missedResp);
        setMissPage(1);
        setMissLogsError('');
        setMissLogsLoading(false);
        setDetail(detailResp.data);
        setSeries(seriesResp.data);
        return;
      }
      const [detailResp, seriesResp] = await Promise.all([detailPromise, seriesPromise]);
      setDetail(detailResp.data);
      setSeries(seriesResp.data);
    } catch (e) {
      if (isMissNode) {
        setMissLogs([]);
        setMissLogsError((e as Error).message || 'MISS 日志获取失败');
        setMissLogsLoading(false);
      }
      setDrawerError((e as Error).message || '节点详情获取失败');
    } finally {
      setDrawerLoading(false);
    }
  }

  function togglePackage(pkgId: string) {
    setExpandedPackages((prev) => (prev.includes(pkgId) ? prev.filter((id) => id !== pkgId) : [...prev, pkgId]));
  }

  function toggleGroup(groupId: string) {
    setExpandedGroups((prev) => (prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId]));
  }

  function onPickRange(key: string) {
    setDraftRange(key);
    const selected = QUICK_RANGES.find((x) => x.key === key);
    if (!selected) return;
    const end = new Date();
    const start = new Date(end.getTime() - selected.minutes * 60 * 1000);
    setDraftStart(toInputValue(start.toISOString()));
    setDraftEnd(toInputValue(end.toISOString()));
  }

  async function onApplyTime() {
    const nextStart = toIsoFromInput(draftStart);
    const nextEnd = toIsoFromInput(draftEnd);
    if (!nextStart || !nextEnd) {
      setError('时间格式无效');
      return;
    }
    if (new Date(nextStart).getTime() > new Date(nextEnd).getTime()) {
      setError('开始时间不能大于结束时间');
      return;
    }

    setError('');
    setStartTime(nextStart);
    setEndTime(nextEnd);
    const preset = QUICK_RANGES.find((x) => x.key === draftRange);
    setRangeLabel(preset?.label ?? `${draftStart} - ${draftEnd}`);
    setTimePanelOpen(false);
    await loadSnapshot(nextStart, nextEnd);
  }

  async function onSelectParsePackage(packageId: string, packageName: string) {
    setExpandedPackages((prev) => (prev.includes(packageId) ? prev : [...prev, packageId]));
    setParseQuery(packageName);
    setParseSearchOpen(false);
    await openDetail(packageId);
  }

  async function onSelectParseLog(packageId: string, logId: string, packageName: string, logName: string) {
    setExpandedPackages((prev) => (prev.includes(packageId) ? prev : [...prev, packageId]));
    setParseQuery(`${packageName} / ${logName}`);
    setParseSearchOpen(false);
    await openDetail(logId);
  }

  async function onSelectParseItem(item: ParseSearchItem) {
    if (item.type === 'package') {
      await onSelectParsePackage(item.packageId, item.packageName);
      return;
    }
    await onSelectParseLog(item.packageId, item.logId, item.packageName, item.logName);
  }

  async function onParseSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!parseSearchOpen || !parseQuery.trim()) return;
    if (parseSearchFlatItems.length === 0) {
      if (e.key === 'Escape') {
        setParseSearchOpen(false);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setParseSearchActiveIndex((prev) => (prev + 1) % parseSearchFlatItems.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setParseSearchActiveIndex((prev) => (prev - 1 + parseSearchFlatItems.length) % parseSearchFlatItems.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = parseSearchFlatItems[parseSearchActiveIndex];
      if (item) await onSelectParseItem(item);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setParseSearchOpen(false);
    }
  }

  function moveParseSelection(delta: number) {
    if (!parseSearchOpen || !parseQuery.trim() || parseSearchFlatItems.length === 0) return;
    setParseSearchActiveIndex((prev) => (prev + delta + parseSearchFlatItems.length) % parseSearchFlatItems.length);
  }

  return (
    <div className="app" id="app">
      <div className="title-wrap">
        <div className="title">WP 监控 - 日志链路总览（V3）</div>
        <div className="toolbar-right">
          <div ref={timePickerRef} className={`wd-time-picker ${timePanelOpen ? 'open' : ''}`}>
            <button
              className="wd-chip wd-time-toggle"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setTimePanelOpen((v) => !v);
              }}
            >
              <span>{rangeLabel}</span>
              <span className="wd-time-toggle-caret">▾</span>
            </button>
            <div className={`wd-time-panel ${timePanelOpen ? '' : 'hidden'}`}>
              <section className="wd-time-panel-col">
                <h4 className="wd-time-panel-title">From:</h4>
                <div className="wd-time-custom-inputs">
                  <div className="wd-chip">
                    <input className="wd-time-input" type="datetime-local" step={1} value={draftStart} onChange={(e) => setDraftStart(e.target.value)} />
                  </div>
                  <h4 className="wd-time-panel-title">To:</h4>
                  <div className="wd-chip">
                    <input className="wd-time-input" type="datetime-local" step={1} value={draftEnd} onChange={(e) => setDraftEnd(e.target.value)} />
                  </div>
                </div>
                <div className="wd-time-inline">
                  <span>UTC</span>
                  <span className="wd-time-inline-badge">UTC+08:00</span>
                </div>
                <button
                  className="wd-time-now"
                  type="button"
                  onClick={() => {
                    setDraftRange('15m');
                    onPickRange('15m');
                  }}
                >
                  ⏱ 切换到当前
                </button>
                <div className="wd-time-panel-actions">
                  <button className="wd-time-btn btn-wow-ghost" type="button" onClick={() => setTimePanelOpen(false)}>
                    取消
                  </button>
                  <button className="wd-time-btn btn-wow-primary" type="button" onClick={() => void onApplyTime()}>
                    应用
                  </button>
                </div>
              </section>
              <section className="wd-time-panel-col">
                <h4 className="wd-time-panel-title">快捷时间</h4>
                <p className="wd-time-panel-note">选择后点击应用</p>
                <div className="wd-time-quick-list">
                  {QUICK_RANGES.map((r) => (
                    <button key={r.key} className={`wd-time-quick-btn ${draftRange === r.key ? 'active' : ''}`} type="button" onClick={() => onPickRange(r.key)}>
                      {r.label}
                    </button>
                  ))}
                  <button className={`wd-time-quick-btn ${draftRange === 'custom' ? 'active' : ''}`} type="button" onClick={() => setDraftRange('custom')}>
                    自定义时间段
                  </button>
                </div>
              </section>
            </div>
          </div>
          <button className="btn-wow-primary wd-time-btn" onClick={() => void onApplyTime()} disabled={loading}>
            查询
          </button>
        </div>
      </div>

      <div className="legend">
        <div className="legend-left">
          <span className={`legend-item ${activeLegend && activeLegend !== 'source' ? 'dim' : ''}`} onMouseEnter={() => setActiveLegend('source')} onMouseLeave={() => setActiveLegend(null)}><span className="symbol">●</span><span>来源节点</span></span>
          <span className={`legend-item ${activeLegend && activeLegend !== 'package' ? 'dim' : ''}`} onMouseEnter={() => setActiveLegend('package')} onMouseLeave={() => setActiveLegend(null)}><span className="symbol">◆</span><span>WPL Package(容器)</span></span>
          <span className={`legend-item ${activeLegend && activeLegend !== 'log' ? 'dim' : ''}`} onMouseEnter={() => setActiveLegend('log')} onMouseLeave={() => setActiveLegend(null)}><span className="symbol">▣</span><span>日志类型</span></span>
          <span className={`legend-item ${activeLegend && activeLegend !== 'group' ? 'dim' : ''}`} onMouseEnter={() => setActiveLegend('group')} onMouseLeave={() => setActiveLegend(null)}><span className="symbol">⬡</span><span>输出分组(容器)</span></span>
          <span className={`legend-item ${activeLegend && activeLegend !== 'sink' ? 'dim' : ''}`} onMouseEnter={() => setActiveLegend('sink')} onMouseLeave={() => setActiveLegend(null)}><span className="symbol">▢</span><span>输出目标</span></span>
          <span className={`legend-item ${activeLegend && activeLegend !== 'miss' ? 'dim' : ''}`} onMouseEnter={() => setActiveLegend('miss')} onMouseLeave={() => setActiveLegend(null)}><span className="symbol">⚠</span><span>MISS</span></span>
        </div>
        <div className="legend-metrics">
          <span className="metric-pill badge">CPU: {snapshot?.sys_metrics.cpu_usage_pct.toFixed(1) ?? '0.0'}%</span>
          <span className="metric-pill badge">MEM: {snapshot?.sys_metrics.memory_used_mb ?? 0} MB</span>
          <span className="metric-pill badge">节点: {nodesCount}</span>
          <span className="metric-pill">自动刷新: 5s</span>
        </div>
      </div>

      {loading && <p>加载中...</p>}
      {error && <p className="error">错误: {error}</p>}

      {snapshot && (
        <div className="canvas" id="canvas">
          <div className="columns">
            <section className="lane">
              <div className="lane-head">
                <div className="lane-title">来源层</div>
              </div>
              <div className="lane-scroll">
                {snapshot.sources.map((n) => (
                  <article
                    key={n.id}
                    className={nodeClass('node card source', n.id, 'source')}
                    onMouseEnter={() => setHoveredNode(n.id)}
                    onMouseLeave={() => setHoveredNode('')}
                    onClick={() => void openDetail(n.id)}
                  >
                    <div className="node-name">● {n.name}</div>
                    <div className="metric">{fmtRate(n.metrics.log_rate_eps)}<br />{fmtCount(n.metrics.log_count)}</div>
                  </article>
                ))}
              </div>
            </section>

            <section className="lane">
              <div className="lane-head">
                <div className="lane-title">Parse</div>
                <div className="lane-actions">
                  <button className="mini-btn" onClick={() => setExpandedPackages(snapshot.parses.map((p) => p.id))}>全部展开</button>
                  <button className="mini-btn" onClick={() => setExpandedPackages([])}>全部收起</button>
                  <div ref={parseSearchRef} className="parse-search">
                    <div className="parse-search-controls">
                      <input
                        className="parse-search-input"
                        value={parseQuery}
                        onChange={(e) => {
                          setParseQuery(e.target.value);
                          setParseSearchOpen(true);
                        }}
                        onFocus={() => setParseSearchOpen(true)}
                        onKeyDown={(e) => void onParseSearchKeyDown(e)}
                        placeholder="搜索 package 或日志类型"
                      />
                    </div>
                    <div className={`parse-search-results ${parseSearchOpen && parseQuery.trim() ? '' : 'hidden'}`}>
                      {parseSearchGroups.length === 0 && (
                        <div className="parse-search-item">无匹配结果</div>
                      )}
                      {parseSearchGroups.map((g) => (
                        <div key={g.pkg.id} className="parse-search-group">
                          <div
                            className={`parse-search-item parse-search-group-title ${parseSearchFlatItems[parseSearchActiveIndex]?.key === `pkg:${g.pkg.id}` ? 'active' : ''}`}
                            onClick={() => void onSelectParsePackage(g.pkg.id, g.pkg.package_name)}
                          >
                            {g.pkg.package_name} package {g.logsMatched.length ? `(${g.logsMatched.length})` : ''}
                          </div>
                          {g.logsMatched.map((l) => (
                            <div
                              key={l.id}
                              className={`parse-search-item child ${parseSearchFlatItems[parseSearchActiveIndex]?.key === `log:${l.id}` ? 'active' : ''}`}
                              onClick={() => void onSelectParseLog(g.pkg.id, l.id, g.pkg.package_name, l.name)}
                            >
                              {g.pkg.package_name} log_type {l.name}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="lane-scroll">
                {snapshot.parses.map((p) => {
                  const isExpanded = expandedPackages.includes(p.id);
                  return (
                    <section
                      key={p.id}
                      className={nodeClass('package card', p.id, 'package')}
                      onMouseEnter={() => setHoveredNode(p.id)}
                      onMouseLeave={() => setHoveredNode('')}
                    >
                      <div className="package-head" onClick={() => togglePackage(p.id)}>
                        <div className="package-title">◆ {p.package_name} (Package)</div>
                        <div className="package-summary">
                          {fmtRate(p.metrics.log_rate_eps)} / {fmtCount(p.metrics.log_count)} (汇总) · {p.logs.length} 个日志类型 · {isExpanded ? '点击收起' : '点击展开'}
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="log-list">
                          {p.logs.map((l) => (
                            <article
                              key={l.id}
                              className={nodeClass('log-item card', l.id, 'log')}
                              onMouseEnter={() => setHoveredNode(l.id)}
                              onMouseLeave={() => setHoveredNode('')}
                              onClick={() => void openDetail(l.id)}
                            >
                              <div className="item-head">
                                <div className="node-name">▣ {l.name}</div>
                                <div className="metric-inline">{fmtRate(l.metrics.log_rate_eps)} / {fmtCount(l.metrics.log_count)}</div>
                              </div>
                            </article>
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}

                <article
                  className={nodeClass('node card miss', snapshot.miss.id, 'miss')}
                  onMouseEnter={() => setHoveredNode(snapshot.miss.id)}
                  onMouseLeave={() => setHoveredNode('')}
                  onClick={() => void openDetail(snapshot.miss.id)}
                >
                  <div className="node-name">⚠ {snapshot.miss.name}</div>
                  <div className="node-sub">未命中任何 WPL 规则</div>
                  <div className="metric">
                    {fmtRate(snapshot.miss.metrics.log_rate_eps)} / {fmtCount(snapshot.miss.metrics.log_count)}
                    <br />
                    (不流向任何输出)
                  </div>
                </article>
              </div>
            </section>

            <section className="lane">
              <div className="lane-head">
                <div className="lane-title">输出层（输出分组包含目标）</div>
                <div className="lane-actions">
                  <button className="mini-btn" onClick={() => setExpandedGroups(snapshot.sinks.map((g) => g.id))}>全部展开</button>
                  <button className="mini-btn" onClick={() => setExpandedGroups([])}>全部收起</button>
                </div>
              </div>
              <div className="lane-scroll">
                {snapshot.sinks.map((g) => {
                  const isExpanded = expandedGroups.includes(g.id);
                  return (
                    <section
                      key={g.id}
                      className={nodeClass('group card', g.id, 'group')}
                      onMouseEnter={() => setHoveredNode(g.id)}
                      onMouseLeave={() => setHoveredNode('')}
                    >
                      <div onClick={() => toggleGroup(g.id)}>
                        <div className="group-title">⬡ {g.sink_group}</div>
                        <div className="package-summary">
                          {fmtRate(g.metrics.log_rate_eps)} / {fmtCount(g.metrics.log_count)} · {g.sinks.length} 个输出目标 · {isExpanded ? '点击收起' : '点击展开'}
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="sink-list">
                          {g.sinks.map((s) => (
                            <article
                              key={s.id}
                              className={nodeClass('sink-item card', s.id, 'sink')}
                              onMouseEnter={() => setHoveredNode(s.id)}
                              onMouseLeave={() => setHoveredNode('')}
                              onClick={() => void openDetail(s.id)}
                            >
                              <div className="item-head">
                                <div className="node-name">▢ {s.sink_name}</div>
                                <div className="metric-inline">{fmtRate(s.metrics.log_rate_eps)} / {fmtCount(s.metrics.log_count)}</div>
                              </div>
                            </article>
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      )}

      <aside ref={drawerRef} className={`drawer card ${selectedNode ? 'open' : ''}`}>
        <div className="drawer-head">
          <div className="drawer-title">节点详情</div>
          <button className="drawer-close" onClick={() => setSelectedNode('')}>✕</button>
        </div>

        {drawerLoading && <p>详情加载中...</p>}
        {!drawerLoading && drawerError && <p className="error">错误: {drawerError}</p>}
        {!drawerLoading && !drawerError && detail && (
          <>
            <section className="panel card">
              <div className="panel-title">基本信息</div>
              <p>名称：{detail.name}</p>
              <p>类型：{detail.node_type}</p>
            </section>

            <section className="panel card">
              <div className="panel-title">实时指标</div>
              <p>日志速率：{fmtRate(detail.metrics.log_rate_eps)}</p>
              <p>日志数量：{fmtCount(detail.metrics.log_count)}</p>
              {!isMissSelected && (
                <>
                  <TimeSeriesChart
                    title="速率趋势"
                    points={rateChartPoints}
                    color="#2f6df6"
                    valueFormatter={formatRate2}
                    axisValueFormatter={formatRate2}
                    rangeStartLabel={formatLocalTime(detailStartTime)}
                    rangeEndLabel={formatLocalTime(detailEndTime)}
                    showRangeMeta={false}
                  />
                  <TimeSeriesChart
                    title="数量趋势"
                    points={series?.log_count ?? []}
                    color="#2f6df6"
                    valueFormatter={formatCount}
                    axisValueFormatter={formatCountAxis}
                    rangeStartLabel={formatLocalTime(detailStartTime)}
                    rangeEndLabel={formatLocalTime(detailEndTime)}
                    showRangeMeta={false}
                  />
                </>
              )}
              <p>时间窗口：{formatLocalDateTime(detailStartTime)} - {formatLocalDateTime(detailEndTime)}</p>
            </section>

            {isMissSelected && (
              <section className="panel card">
                <div className="panel-title">MISS 原始日志</div>
                <div className="miss-query-toolbar">
                  <label className="miss-limit-label" htmlFor="miss-limit-input">查询条数上限(1-100)</label>
                  <input
                    id="miss-limit-input"
                    className="miss-limit-input"
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={missLimitInput}
                    onChange={(e) => setMissLimitInput(e.target.value)}
                  />
                  <button className="mini-btn" type="button" onClick={() => void onApplyMissLimit()}>
                    重新查询
                  </button>
                </div>
                {missLogsLoading && <p>MISS 日志加载中...</p>}
                {!missLogsLoading && missLogsError && <p className="error">错误: {missLogsError}</p>}
                {!missLogsLoading && !missLogsError && missLogs.length === 0 && <p>当前时间窗口无 MISS 日志</p>}
                {!missLogsLoading && !missLogsError && missLogs.length > 0 && (
                  <>
                    <p className="miss-page-meta">
                      已加载 {missLogs.length} 条（查询上限 {missQueryLimit}），当前第 {Math.min(missPage, missTotalPages)} / {missTotalPages} 页（每页 10 条）
                    </p>
                    <div className="miss-scroll">
                      <div className="miss-list">
                        {missPageItems.map((item, idx) => {
                          const offset = (Math.min(missPage, missTotalPages) - 1) * MISS_PAGE_SIZE;
                          const rowNo = offset + idx + 1;
                          return (
                            <article key={`${item.time}-${item.stream_id}-${rowNo}`} className="miss-record">
                              <div className="miss-record-head">#{rowNo} | {formatLocalDateTime(item.time)}</div>
                              <pre className="miss-record-raw">{item.raw}</pre>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                    <div className="miss-pager">
                      <button
                        className="mini-btn"
                        type="button"
                        disabled={missPage <= 1 || missLogsLoading}
                        onClick={() => void onPrevMissPage()}
                      >
                        上一页
                      </button>
                      <button
                        className="mini-btn"
                        type="button"
                        disabled={
                          missLogsLoading || (
                            missPage >= missTotalPages &&
                            !(missQueryLimit < 100 && missLogs.length >= missQueryLimit)
                          )
                        }
                        onClick={() => void onNextMissPage()}
                      >
                        下一页
                      </button>
                    </div>
                  </>
                )}
              </section>
            )}
          </>
        )}

        {!drawerLoading && !drawerError && !detail && <p>点击节点查看详情</p>}
      </aside>
    </div>
  );
}
