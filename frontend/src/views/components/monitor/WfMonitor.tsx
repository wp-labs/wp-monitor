import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@/context/ThemeContext';
import TimeSeriesChart from '@/views/components/monitor/TimeSeriesChart';
import { getPalette } from '@/views/components/monitor/chartPalette';
import {
  fetchWfPipeline,
  fetchWfSources,
  fetchWfSourceMachines,
  fetchWfWindows,
  fetchWfRules,
  fetchWfStateMachines,
  fetchWfRuleMachines,
  fetchWfTimeseriesThroughput,
  fetchWfTimeseriesWindows,
  fetchWfTimeseriesAlerts,
} from '@/services/monitor';
import type {
  WfPipelineResponse,
  WfSourceItem,
  WfSourceMachineItem,
  WfWindowItem,
  WfRuleItem,
  WfStateMachineItem,
  WfRuleMachineItem,
  NodeTimeSeries,
  TimePoint,
} from '@/types/monitor';
import './WfMonitor.css';

// ── helpers ──

function fmtNum(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return n.toLocaleString();
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GiB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MiB';
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KiB';
  return n + ' B';
}

const PAGE_SIZE = 10;
const REFRESH_MS = 5000;

// ── small metric row ──

function MRol({
  label,
  value,
  unit,
  color,
}: {
  label: string;
  value: string;
  unit?: string;
  color?: string;
}) {
  return (
    <div className="metric-row">
      <span className="m-label">{label}</span>
      <span>
        <span className="m-value" style={color ? { color } : undefined}>
          {value}
        </span>
        {unit ? <span className="m-unit">{unit}</span> : null}
      </span>
    </div>
  );
}

// ── Pipeline stages ──

function PipelineStages({ pipeline }: { pipeline: WfPipelineResponse }) {
  const { receiver, window, rule } = pipeline;
  const errColor = receiver.route_errors > 0 ? 'var(--warning)' : undefined;
  const lateColor = window.late_dropped > 0 ? 'var(--warning)' : undefined;
  const failColor = rule.send_failed > 0 ? 'var(--danger)' : undefined;

  return (
    <div className="pipeline">
      <div className="stage">
        <div className="stage-head">
          <div className="stage-icon rcv">⇩</div>
          <div>
            <div className="stage-title">数据接入</div>
            <div className="stage-subtitle">{receiver.source_count} 个来源</div>
          </div>
        </div>
        <div className="metric-grid">
          <MRol label="接收行数" value={fmtNum(receiver.total_rows)} unit="条" />
          <MRol label="路由错误" value={fmtNum(receiver.route_errors)} unit="次" color={errColor} />
          <MRol label="速率" value={fmtNum(receiver.rate_rows_per_sec)} unit="行/秒" />
        </div>
      </div>

      <div className="stage">
        <div className="stage-head">
          <div className="stage-icon win">⊞</div>
          <div>
            <div className="stage-title">数据窗口</div>
            <div className="stage-subtitle">{window.window_count} 个窗口</div>
          </div>
        </div>
        <div className="metric-grid">
          <MRol label="数据量" value={fmtNum(window.total_rows)} unit="条" />
          <MRol label="内存占用" value={fmtBytes(window.total_memory_bytes)} />
          <MRol label="迟到丢弃" value={fmtNum(window.late_dropped)} unit="条" color={lateColor} />
        </div>
      </div>

      <div className="stage">
        <div className="stage-head">
          <div className="stage-icon rul">◎</div>
          <div>
            <div className="stage-title">规则检测 & 输出</div>
            <div className="stage-subtitle">{rule.rule_count} 条规则 · 命中率 {rule.hit_rate_pct.toFixed(1)}%</div>
          </div>
        </div>
        <div className="metric-grid">
          <MRol label="状态机实例" value={fmtNum(rule.total_state_machines)} unit="个" />
          <MRol label="产出告警" value={fmtNum(rule.total_emitted)} unit="条" />
          <MRol label="下发失败" value={fmtNum(rule.send_failed)} unit="次" color={failColor} />
        </div>
      </div>
    </div>
  );
}

// ── Table sort / paginate helpers ──

type SortDir = 'asc' | 'desc';

interface PageState {
  page: number;
  sortBy: string;
  sortDir: SortDir;
}

function sortItems<T>(items: T[], by: string, dir: SortDir, getter: (item: T, field: string) => string | number): T[] {
  return [...items].sort((a, b) => {
    let va = getter(a, by);
    let vb = getter(b, by);
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function sortHeader(label: string, field: string, ps: PageState, num?: boolean) {
  const active = ps.sortBy === field;
  const arrow = active ? (ps.sortDir === 'asc' ? '▲' : '▼') : '';
  return (
    <th
      className={(num ? 'num ' : '') + 'sortable' + (active ? ' sorted' : '')}
      data-sort={field}
    >
      {label}
      <span className="sort-arrow">{arrow}</span>
    </th>
  );
}

function Pagination({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (p: number) => void;
}) {
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  const pages: (number | '...')[] = [];
  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 7 && i > 2 && i < totalPages - 1 && Math.abs(i - page) > 1) {
      if (pages[pages.length - 1] !== '...') pages.push('...');
      continue;
    }
    pages.push(i);
  }
  return (
    <div className="pager">
      <button disabled={page <= 1} onClick={() => onChange(page - 1)}>
        ‹
      </button>
      {pages.map((p, i) =>
        p === '...' ? (
          <span key={`dot-${i}`} className="page-info">…</span>
        ) : (
          <button
            key={p}
            className={p === page ? 'active' : ''}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        ),
      )}
      <button disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        ›
      </button>
      <span className="page-info">共 {total} 条</span>
    </div>
  );
}

// ── Source table ──

function SourceTable({ sources, timeRange }: { sources: WfSourceItem[]; timeRange: { start: string; end: string } }) {
  const [ps, setPs] = useState<PageState>({ page: 1, sortBy: 'rows', sortDir: 'desc' });
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'active' | 'quiet'>('active');
  const [groupBy, setGroupBy] = useState<'source' | 'machine'>('source');
  const [machineData, setMachineData] = useState<WfSourceMachineItem[] | null>(null);
  const [machineLoading, setMachineLoading] = useState(false);

  // lazy-load machine data, re-fetch on time change; only show loading on initial fetch
  useEffect(() => {
    if (groupBy === 'machine') {
      if (!machineData) setMachineLoading(true);
      fetchWfSourceMachines(timeRange.start, timeRange.end).then((r) => {
        setMachineData(r.data);
        setMachineLoading(false);
      });
    }
  }, [groupBy, timeRange.start, timeRange.end]);

  // source mode
  const srcFiltered = useMemo(() => {
    let list = sources.filter((s) => (s.rows > 0) === (mode === 'active'));
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(q));
    }
    return sortItems(list, ps.sortBy, ps.sortDir, (s, f) => {
      if (f === 'name') return s.name;
      if (f === 'type') return s.type;
      if (f === 'errs') return s.route_errors;
      return s.rows;
    });
  }, [sources, mode, search, ps]);

  // machine mode
  const macFiltered = useMemo(() => {
    const list = (machineData || []).filter((m) => (m.rows > 0) === (mode === 'active'));
    return sortItems(list, ps.sortBy, ps.sortDir, (m, f) => {
      if (f === 'name') return m.machine;
      if (f === 'count') return m.source_count;
      if (f === 'errs') return m.route_errors;
      return m.rows;
    });
  }, [machineData, mode, ps]);

  const total = groupBy === 'machine' ? macFiltered.length : srcFiltered.length;
  const pageItems =
    groupBy === 'machine'
      ? macFiltered.slice((ps.page - 1) * PAGE_SIZE, ps.page * PAGE_SIZE)
      : srcFiltered.slice((ps.page - 1) * PAGE_SIZE, ps.page * PAGE_SIZE);

  const pad = PAGE_SIZE - pageItems.length;

  const handleSort = (field: string) => {
    setPs((prev) => ({
      page: 1,
      sortBy: field,
      sortDir: prev.sortBy === field && prev.sortDir === 'desc' ? 'asc' : 'desc',
    }));
  };

  const resetPage = () => setPs((prev) => ({ ...prev, page: 1 }));

  return (
    <div className="panel">
      <div className="panel-header">
        <span>来源详情</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="pill-toggle">
            <span className="pill-slider" />
            <span
              className={'pill-option' + (groupBy === 'source' ? ' active' : '')}
              onClick={() => { setGroupBy('source'); resetPage(); }}
            >
              来源
            </span>
            <span
              className={'pill-option' + (groupBy === 'machine' ? ' active' : '')}
              onClick={() => { setGroupBy('machine'); resetPage(); }}
            >
              设备
            </span>
          </span>
          <span className="filter-toggle">
            <span
              className={'ft-btn' + (mode === 'active' ? ' active' : '')}
              onClick={() => { setMode('active'); resetPage(); }}
            >
              活跃
            </span>
            <span
              className={'ft-btn' + (mode === 'quiet' ? ' active' : '')}
              onClick={() => { setMode('quiet'); resetPage(); }}
            >
              静默
            </span>
          </span>
          <input
            className="search-input"
            placeholder="搜索..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetPage(); }}
          />
        </span>
      </div>
      <div className="panel-body">
        {machineLoading ? (
          <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>加载中...</div>
        ) : (
          <table>
            <thead onClick={(e) => {
              const th = (e.target as HTMLElement).closest('th.sortable');
              if (th) handleSort((th as HTMLElement).dataset.sort!);
            }}>
              <tr>
                {groupBy === 'machine'
                  ? (
                    <>
                      {sortHeader('设备', 'name', ps)}
                      {sortHeader('来源数', 'count', ps, true)}
                      {sortHeader('接收行数', 'rows', ps, true)}
                      {sortHeader('路由错误', 'errs', ps, true)}
                    </>
                  )
                  : (
                    <>
                      {sortHeader('来源', 'name', ps)}
                      {sortHeader('类型', 'type', ps)}
                      {sortHeader('接收行数', 'rows', ps, true)}
                      {sortHeader('路由错误', 'errs', ps, true)}
                    </>
                  )}
              </tr>
            </thead>
            <tbody>
              {pageItems.map((item) =>
                groupBy === 'machine'
                  ? (
                    <tr key={(item as WfSourceMachineItem).machine}>
                      <td className="name">{(item as WfSourceMachineItem).machine}</td>
                      <td className="num">{(item as WfSourceMachineItem).source_count}</td>
                      <td className="num">{fmtNum(item.rows)}</td>
                      <td className="num" style={{ color: (item as WfSourceMachineItem).route_errors > 0 ? 'var(--warning)' : 'var(--text-dim)' }}>
                        {(item as WfSourceMachineItem).route_errors}
                      </td>
                    </tr>
                  )
                  : (
                    <tr key={(item as WfSourceItem).name}>
                      <td className="name">{(item as WfSourceItem).name}</td>
                      <td className="dim">{(item as WfSourceItem).type}</td>
                      <td className="num">{fmtNum(item.rows)}</td>
                      <td className="num" style={{ color: (item as WfSourceItem).route_errors > 0 ? 'var(--warning)' : 'var(--text-dim)' }}>
                        {(item as WfSourceItem).route_errors}
                      </td>
                    </tr>
                  ),
              )}
              {Array.from({ length: pad }, (_, i) => (
                <tr key={`pad-${i}`} className="pad-row">
                  <td colSpan={10}>&nbsp;</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Pagination
        page={ps.page}
        total={total}
        onChange={(p) => setPs((prev) => ({ ...prev, page: p }))}
      />
    </div>
  );
}

// ── Window table ──

function WindowTable({ windows }: { windows: WfWindowItem[] }) {
  const [ps, setPs] = useState<PageState>({ page: 1, sortBy: 'rows', sortDir: 'desc' });
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'active' | 'quiet'>('active');

  const filtered = useMemo(() => {
    let list = windows.filter((w) => (w.rows > 0) === (mode === 'active'));
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((w) => w.name.toLowerCase().includes(q));
    }
    return sortItems(list, ps.sortBy, ps.sortDir, (w, f) => {
      if (f === 'name') return w.name;
      if (f === 'late') return w.late_dropped;
      if (f === 'mem') return w.memory_bytes;
      if (f === 'pct') return w.capacity_bytes > 0 ? w.memory_bytes / w.capacity_bytes : 0;
      return w.rows;
    });
  }, [windows, mode, search, ps]);

  const total = filtered.length;
  const pageItems = filtered.slice((ps.page - 1) * PAGE_SIZE, ps.page * PAGE_SIZE);
  const pad = PAGE_SIZE - pageItems.length;

  const handleSort = (field: string) => {
    setPs((prev) => ({
      page: 1,
      sortBy: field,
      sortDir: prev.sortBy === field && prev.sortDir === 'desc' ? 'asc' : 'desc',
    }));
  };

  const resetPage = () => setPs((prev) => ({ ...prev, page: 1 }));

  return (
    <div className="panel">
      <div className="panel-header">
        <span>窗口详情</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="filter-toggle">
            <span className={'ft-btn' + (mode === 'active' ? ' active' : '')} onClick={() => { setMode('active'); resetPage(); }}>活跃</span>
            <span className={'ft-btn' + (mode === 'quiet' ? ' active' : '')} onClick={() => { setMode('quiet'); resetPage(); }}>静默</span>
          </span>
          <input
            className="search-input"
            placeholder="搜索窗口..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetPage(); }}
          />
        </span>
      </div>
      <div className="panel-body">
        <table>
          <thead onClick={(e) => {
            const th = (e.target as HTMLElement).closest('th.sortable');
            if (th) handleSort((th as HTMLElement).dataset.sort!);
          }}>
            <tr>
              {sortHeader('窗口', 'name', ps)}
              {sortHeader('数据量', 'rows', ps, true)}
              {sortHeader('迟到', 'late', ps, true)}
              {sortHeader('内存', 'mem', ps)}
              {sortHeader('占比', 'pct', ps)}
            </tr>
          </thead>
          <tbody>
            {pageItems.map((w) => {
              const memPct = Math.min(100, w.capacity_bytes > 0 ? (w.memory_bytes / w.capacity_bytes) * 100 : 0);
              const memMB = w.memory_bytes / (1 << 20);
              const capMB = w.capacity_bytes / (1 << 20);
              const memColor = memPct > 80 ? 'var(--danger)' : memPct > 60 ? 'var(--warning)' : 'var(--success)';
              return (
                <tr key={w.name}>
                  <td className="name">{w.name}</td>
                  <td className="num" style={{ color: w.rows > 5000 ? 'var(--warning)' : undefined }}>{fmtNum(w.rows)}</td>
                  <td className="num" style={{ color: w.late_dropped > 0 ? 'var(--warning)' : 'var(--text-dim)' }}>{fmtNum(w.late_dropped)}</td>
                  <td>
                    <span className="bar-num">{memMB.toFixed(1)}<span className="bar-cap"> / {capMB.toFixed(0)} MiB</span></span>
                  </td>
                  <td>
                    <div className="bar-cell">
                      <div className="bar"><div className="bar-fill" style={{ width: `${memPct}%`, background: memColor }} /></div>
                      <span className="bar-pct">{memPct.toFixed(0)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
            {Array.from({ length: pad }, (_, i) => (
              <tr key={`pad-${i}`} className="pad-row"><td colSpan={10}>&nbsp;</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={ps.page} total={total} onChange={(p) => setPs((prev) => ({ ...prev, page: p }))} />
    </div>
  );
}

// ── State machine popover ──

function SmPopover({
  ruleName,
  totalEmitted,
  startTime,
  endTime,
  triggerEl,
  onClose,
}: {
  ruleName: string;
  totalEmitted: number;
  startTime: string;
  endTime: string;
  triggerEl: HTMLElement;
  onClose: () => void;
}) {
  const [allItems, setAllItems] = useState<WfStateMachineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pos, setPos] = useState<{ top: number; left: number; dir: 'above' | 'below'; arrowX: number }>({ top: 0, left: 0, dir: 'above', arrowX: 50 });
  const [visible, setVisible] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWfStateMachines(ruleName, startTime, endTime).then((r) => {
      if (!cancelled) {
        setAllItems(r.data);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [ruleName, startTime, endTime]);

  // position popover relative to trigger
  useEffect(() => {
    if (loading) return;
    const rect = triggerEl.getBoundingClientRect();
    const popW = popRef.current?.offsetWidth || 200;
    const popH = popRef.current?.offsetHeight || 140;
    const spaceAbove = rect.top;
    const dir = spaceAbove > popH + 12 ? 'above' : 'below' as const;

    // right-align if trigger is on right half, left-align otherwise
    const triggerCenter = rect.left + rect.width / 2;
    let left: number;
    if (triggerCenter > window.innerWidth / 2) {
      left = Math.min(rect.right - popW, window.innerWidth - popW - 8);
      left = Math.max(left, 8);
    } else {
      left = Math.max(rect.left, 8);
      left = Math.min(left, window.innerWidth - popW - 8);
    }

    const top = dir === 'above' ? rect.top - popH - 8 : rect.bottom + 8;
    const arrowX = Math.max(12, Math.min(popW - 12, rect.left + rect.width / 2 - left));
    setPos({ top, left, dir, arrowX });
    setVisible(true);
  }, [triggerEl, loading, allItems]);

  // delayed show
  useEffect(() => {
    if (showTimer.current !== null) {
      clearTimeout(showTimer.current);
    }
    showTimer.current = setTimeout(() => setVisible(true), 200);
    return () => {
      if (showTimer.current !== null) {
        clearTimeout(showTimer.current);
        showTimer.current = null;
      }
    };
  }, [triggerEl]);

  const handleMouseEnter = () => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const handleMouseLeave = () => {
    hideTimer.current = setTimeout(onClose, 150);
  };

  const shown = allItems.slice(0, 4);
  const totalItems = allItems.length;

  return (
    <>
      <div
        ref={popRef}
        className={`sm-popover-global ${pos.dir}${visible ? ' show' : ''}`}
        style={{ top: pos.top, left: pos.left, '--arrow-x': pos.arrowX + 'px' } as React.CSSProperties}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span className="pop-arrow" />
        <div className="pop-body">
          {loading
            ? <div className="pop-item" style={{ color: 'var(--text-dim)' }}>加载中...</div>
            : shown.map((si) => (
              <div className="pop-item" key={si.scope_key}>
                <span className="pop-name">{si.scope_key}</span>
                <span className="pop-bar-wrap">
                  <span
                    className="pop-bar"
                    style={{ width: `${totalEmitted > 0 ? Math.max(2, (si.emitted / totalEmitted) * 100).toFixed(0) : 0}%` }}
                  />
                </span>
                <span className="pop-val">{fmtNum(si.emitted)}</span>
              </div>
            ))}
          {totalItems > 4 && (
            <div
              className="pop-item"
              style={{ justifyContent: 'center', color: 'var(--text-dim)', borderTop: '1px solid var(--border-light)', marginTop: 2, paddingTop: 3, fontSize: 10, cursor: 'pointer' }}
              onClick={() => setFsOpen(true)}
            >
              点击查看全部
            </div>
          )}
        </div>
      </div>

      {fsOpen && (
        <div className="fullscreen-overlay show" style={{ background: 'rgba(0,0,0,0.3)', alignItems: 'center', justifyContent: 'center' }} onClick={() => setFsOpen(false)}>
          <div style={{ maxWidth: 480, width: '100%', background: 'var(--surface-solid)', borderRadius: '8px 8px 0 0', margin: '0 auto', borderBottom: '1px solid var(--border-light)', padding: '12px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{ruleName} · {totalItems} 个实例</span>
            <span style={{ fontSize: 14, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', cursor: 'pointer' }} onClick={() => setFsOpen(false)}>✕</span>
          </div>
          <div style={{ maxWidth: 480, width: '100%', background: 'var(--surface-solid)', borderRadius: '0 0 8px 8px', margin: '0 auto', display: 'flex', flexDirection: 'column', maxHeight: '55vh', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
            <div style={{ padding: '4px 0', overflowY: 'auto' }}>
              {allItems.map((si) => (
                <div className="pop-item" key={si.scope_key}>
                  <span className="pop-name">{si.scope_key}</span>
                  <span className="pop-bar-wrap">
                    <span
                      className="pop-bar"
                      style={{ width: `${totalEmitted > 0 ? Math.max(2, (si.emitted / totalEmitted) * 100).toFixed(0) : 0}%` }}
                    />
                  </span>
                  <span className="pop-val">{fmtNum(si.emitted)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Alert table ──

function AlertTable({ rules, timeRange }: { rules: WfRuleItem[]; timeRange: { start: string; end: string } }) {
  const [ps, setPs] = useState<PageState>({ page: 1, sortBy: 'emitted', sortDir: 'desc' });
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'active' | 'quiet'>('active');
  const [groupBy, setGroupBy] = useState<'rule' | 'machine'>('rule');
  const [machineData, setMachineData] = useState<WfRuleMachineItem[] | null>(null);
  const [hoverRule, setHoverRule] = useState<string | null>(null);
  const [hoverTrigger, setHoverTrigger] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (groupBy === 'machine') {
      fetchWfRuleMachines(timeRange.start, timeRange.end).then((r) => setMachineData(r.data));
    }
  }, [groupBy, timeRange.start, timeRange.end]);

  // rule mode
  const ruleFiltered = useMemo(() => {
    let list = rules.filter((r) => (r.emitted > 0) === (mode === 'active'));
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((r) => r.name.toLowerCase().includes(q));
    }
    return sortItems(list, ps.sortBy, ps.sortDir, (r, f) => {
      if (f === 'name') return r.name;
      if (f === 'instances') return r.instances;
      return r.emitted;
    });
  }, [rules, mode, search, ps]);

  // machine mode
  const macFiltered = useMemo(() => {
    const list = (machineData || []).filter((m) => (m.emitted > 0) === (mode === 'active'));
    return sortItems(list, ps.sortBy, ps.sortDir, (m, f) => {
      if (f === 'name') return m.machine;
      if (f === 'count') return m.rule_count;
      return m.emitted;
    });
  }, [machineData, mode, ps]);

  const total = groupBy === 'machine' ? macFiltered.length : ruleFiltered.length;
  const pageItems =
    groupBy === 'machine'
      ? macFiltered.slice((ps.page - 1) * PAGE_SIZE, ps.page * PAGE_SIZE)
      : ruleFiltered.slice((ps.page - 1) * PAGE_SIZE, ps.page * PAGE_SIZE);
  const pad = PAGE_SIZE - pageItems.length;

  const handleSort = (field: string) => {
    setPs((prev) => ({
      page: 1,
      sortBy: field,
      sortDir: prev.sortBy === field && prev.sortDir === 'desc' ? 'asc' : 'desc',
    }));
  };

  const resetPage = () => setPs((prev) => ({ ...prev, page: 1 }));

  return (
    <div className="panel">
      <div className="panel-header">
        <span>告警详情</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="pill-toggle">
            <span className="pill-slider" />
            <span className={'pill-option' + (groupBy === 'rule' ? ' active' : '')} onClick={() => { setGroupBy('rule'); resetPage(); }}>规则</span>
            <span className={'pill-option' + (groupBy === 'machine' ? ' active' : '')} onClick={() => { setGroupBy('machine'); resetPage(); }}>设备</span>
          </span>
          <span className="filter-toggle">
            <span className={'ft-btn' + (mode === 'active' ? ' active' : '')} onClick={() => { setMode('active'); resetPage(); }}>活跃</span>
            <span className={'ft-btn' + (mode === 'quiet' ? ' active' : '')} onClick={() => { setMode('quiet'); resetPage(); }}>静默</span>
          </span>
          <input
            className="search-input"
            placeholder="搜索..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetPage(); }}
          />
        </span>
      </div>
      <div className="panel-body">
        <table>
          <thead onClick={(e) => {
            const th = (e.target as HTMLElement).closest('th.sortable');
            if (th) handleSort((th as HTMLElement).dataset.sort!);
          }}>
            <tr>
              {groupBy === 'machine'
                ? (
                  <>
                    {sortHeader('设备', 'name', ps)}
                    {sortHeader('关联规则', 'count', ps, true)}
                    {sortHeader('产出告警', 'emitted', ps, true)}
                  </>
                )
                : (
                  <>
                    {sortHeader('规则', 'name', ps)}
                    {sortHeader('产出告警', 'emitted', ps, true)}
                    {sortHeader('状态机实例', 'instances', ps, true)}
                  </>
                )}
            </tr>
          </thead>
          <tbody>
            {pageItems.map((item) => {
              if (groupBy === 'machine') {
                const m = item as WfRuleMachineItem;
                return (
                  <tr key={m.machine}>
                    <td className="name">{m.machine}</td>
                    <td className="num">{m.rule_count}</td>
                    <td className="num" style={{ color: m.emitted > 0 ? 'var(--orange)' : 'var(--text-dim)' }}>{fmtNum(m.emitted)}</td>
                  </tr>
                );
              }
              const r = item as WfRuleItem;
              const cell =
                r.instances > 0 ? (
                  <span
                    className="sm-trigger"
                    data-rule={r.name}
                    onMouseEnter={(e) => {
                      setHoverRule(r.name);
                      setHoverTrigger(e.currentTarget as HTMLElement);
                    }}
                    onMouseLeave={() => setHoverRule(null)}
                  >
                    {r.instances}
                  </span>
                ) : (
                  <span>{r.instances}</span>
                );
              return (
                <tr key={r.name}>
                  <td className="name">{r.name}</td>
                  <td className="num" style={{ color: r.emitted > 0 ? 'var(--orange)' : 'var(--text-dim)' }}>{fmtNum(r.emitted)}</td>
                  <td className="num">{cell}</td>
                </tr>
              );
            })}
            {Array.from({ length: pad }, (_, i) => (
              <tr key={`pad-${i}`} className="pad-row"><td colSpan={10}>&nbsp;</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={ps.page} total={total} onChange={(p) => setPs((prev) => ({ ...prev, page: p }))} />

      {/* global popover positioned relative to trigger */}
      {hoverRule && hoverTrigger && (
        <SmPopover
          ruleName={hoverRule}
          totalEmitted={rules.find((r) => r.name === hoverRule)?.emitted || 0}
          startTime={timeRange.start}
          endTime={timeRange.end}
          triggerEl={hoverTrigger}
          onClose={() => setHoverRule(null)}
        />
      )}
    </div>
  );
}

// ── Trend chart wrapper ──

function TrendChart({
  title,
  seriesList,
  palette,
  metricTabs,
  activeMetric,
  onMetricChange,
  gridColor,
  labelColor,
  onExpand,
  yAxisUnit,
  valueFormatter: vfProp,
  axisValueFormatter: avfProp,
}: {
  title: string;
  seriesList: Array<{ name: string; points: TimePoint[]; color: string }>;
  palette: string[];
  metricTabs?: { key: string; label: string }[];
  activeMetric?: string;
  onMetricChange?: (key: string) => void;
  gridColor: string;
  labelColor: string;
  onExpand?: () => void;
  yAxisUnit?: string;
  valueFormatter?: (v: number) => string;
  axisValueFormatter?: (v: number) => string;
}) {
  const multiSeries = seriesList.length > 1 ? seriesList : undefined;
  const singlePoints = seriesList.length === 1 ? seriesList[0].points : [];
  const color = seriesList.length === 1 ? seriesList[0].color : palette[0];
  const vf = vfProp ?? ((v: number) => fmtNum(v));
  const avf = avfProp ?? ((v: number) => fmtNum(v));

  return (
    <div className="panel">
      <div className="panel-header">
        <span>{title}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {metricTabs && (
            <span className="chart-tabs">
              {metricTabs.map((t) => (
                <span
                  key={t.key}
                  className={`ctab${t.key === activeMetric ? ' active' : ''}`}
                  onClick={() => onMetricChange?.(t.key)}
                >
                  {t.label}
                </span>
              ))}
            </span>
          )}
          {onExpand && (
            <span className="expand-btn" onClick={onExpand} title="全屏">
              ⛶
            </span>
          )}
        </span>
      </div>
      <div className="panel-body">
        <div className="chart-wrap">
          {seriesList.length > 0 ? (
            <TimeSeriesChart
              title={title}
              points={singlePoints}
              multiSeries={multiSeries}
              color={color}
              showLegend={multiSeries !== undefined}
              valueFormatter={vf}
              axisValueFormatter={avf}
              minY={0}
              yTickAmount={5}
              gridColor={gridColor}
              labelColor={labelColor}
              hideXAxis
              yAxisUnit={yAxisUnit}
              legendPosition="bottom"
              legendAlign="center"
              legendFontSize="10px"
              legendMarkerSize={5}
            />
          ) : (
            <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>暂无数据</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main WfMonitor ──

export default function WfMonitor({ startTime, endTime }: { startTime: string; endTime: string }) {
  const { theme } = useTheme();
  const palette = useMemo(() => getPalette(theme), [theme]);

  const [pipeline, setPipeline] = useState<WfPipelineResponse | null>(null);
  const [sources, setSources] = useState<WfSourceItem[]>([]);
  const [windows, setWindows] = useState<WfWindowItem[]>([]);
  const [rules, setRules] = useState<WfRuleItem[]>([]);

  const [throughputGroupBy] = useState<'source' | 'machine'>('source');
  const [throughputSeries, setThroughputSeries] = useState<NodeTimeSeries[]>([]);

  const [windowMetric, setWindowMetric] = useState('rows');
  const [windowSeries, setWindowSeries] = useState<NodeTimeSeries[]>([]);

  const [alertGroupBy] = useState<'rule' | 'machine'>('rule');
  const [alertSeries, setAlertSeries] = useState<NodeTimeSeries[]>([]);
  const [fsOpen, setFsOpen] = useState(false);
  const [fsTitle, setFsTitle] = useState('');
  const [fsSeriesList, setFsSeriesList] = useState<Array<{ name: string; points: TimePoint[]; color: string }>>([]);
  const [fsPalette, setFsPalette] = useState<string[]>([]);
  const [fsYAxisUnit, setFsYAxisUnit] = useState<string | undefined>(undefined);
  const [fsValueFormatter, setFsValueFormatter] = useState<((v: number) => string) | undefined>(undefined);
  const [fsAxisValueFormatter, setFsAxisValueFormatter] = useState<((v: number) => string) | undefined>(undefined);

  const chartColors = useMemo(() => {
    const isLight = theme === 'light-modern';
    return {
      grid: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)',
      label: isLight ? '#aeaeb2' : '#69655e',
    };
  }, [theme]);

  const timeRange = useMemo(() => ({ start: startTime, end: endTime }), [startTime, endTime]);
  const timeRangeRef = useRef(timeRange);
  timeRangeRef.current = timeRange;

  // initial load + reload on time range change
  useEffect(() => {
    loadAll();
  }, [startTime, endTime]);

  // periodic refresh
  useEffect(() => {
    const timer = setInterval(loadAll, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  async function loadAll() {
    const tr = timeRangeRef.current;
    const startMs = new Date(tr.start).getTime();
    const endMs = new Date(tr.end).getTime();
    const durationMs = endMs - startMs;
    const now = Date.now();
    const e = new Date(now).toISOString();
    const s = new Date(now - (durationMs > 0 ? durationMs : 5 * 60 * 1000)).toISOString();

    const [pipelineRes, sourcesRes, windowsRes, rulesRes] = await Promise.all([
      fetchWfPipeline(s, e),
      fetchWfSources(s, e),
      fetchWfWindows(s, e),
      fetchWfRules(s, e),
    ]);
    setPipeline(pipelineRes.data);
    setSources(sourcesRes.data);
    setWindows(windowsRes.data);
    setRules(rulesRes.data);

    // timeseries
    const [tsRes, wsRes, asRes] = await Promise.all([
      fetchWfTimeseriesThroughput(s, e, throughputGroupBy),
      fetchWfTimeseriesWindows(s, e, windowMetric),
      fetchWfTimeseriesAlerts(s, e, alertGroupBy),
    ]);
    setThroughputSeries(tsRes.data);
    setWindowSeries(wsRes.data);
    setAlertSeries(asRes.data);
  }

  // build chart series
  const throughputChartSeries = useMemo(() => {
    return throughputSeries.map((s, i) => ({
      name: s.node_id,
      points: s.log_rate_eps,
      color: palette[i % palette.length],
    }));
  }, [throughputSeries, palette]);

  const windowChartSeries = useMemo(() => {
    return windowSeries.map((s, i) => ({
      name: s.node_id,
      points: s.log_rate_eps,
      color: palette[i % palette.length],
    }));
  }, [windowSeries, palette]);

  const alertChartSeries = useMemo(() => {
    return alertSeries.map((s, i) => ({
      name: s.node_id,
      points: s.log_rate_eps,
      color: palette[i % palette.length],
    }));
  }, [alertSeries, palette]);

  const winFormatter = useMemo(() => {
    if (windowMetric === 'memory') {
      return { vf: (v: number) => fmtBytes(v), avf: (v: number) => fmtBytes(v), unit: undefined };
    }
    return { vf: (v: number) => fmtNum(v), avf: (v: number) => fmtNum(v), unit: '条' as string | undefined };
  }, [windowMetric]);

  if (!pipeline) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>加载中...</div>;
  }

  return (
    <div className="main">
      <PipelineStages pipeline={pipeline} />

      <div className="grid-3">
        <SourceTable sources={sources} timeRange={timeRange} />
        <WindowTable windows={windows} />
        <AlertTable rules={rules} timeRange={timeRange} />
      </div>

      <div className="grid-3">
        <TrendChart
          title="数据流入"
          seriesList={throughputChartSeries}
          palette={palette}
          yAxisUnit="eps"
          gridColor={chartColors.grid}
          labelColor={chartColors.label}
          onExpand={() => { setFsTitle('数据流入'); setFsSeriesList(throughputChartSeries); setFsPalette(palette); setFsYAxisUnit('eps'); setFsValueFormatter(undefined); setFsAxisValueFormatter(undefined); setFsOpen(true); }}
        />
        <TrendChart
          title="窗口曲线"
          seriesList={windowChartSeries}
          palette={palette}
          yAxisUnit={winFormatter.unit}
          valueFormatter={winFormatter.vf}
          axisValueFormatter={winFormatter.avf}
          gridColor={chartColors.grid}
          labelColor={chartColors.label}
          metricTabs={[
            { key: 'rows', label: '数据量' },
            { key: 'memory', label: '内存' },
            { key: 'late', label: '迟到' },
          ]}
          activeMetric={windowMetric}
          onMetricChange={setWindowMetric}
          onExpand={() => { setFsTitle('窗口曲线'); setFsSeriesList(windowChartSeries); setFsPalette(palette); setFsYAxisUnit(winFormatter.unit); setFsValueFormatter(winFormatter.vf); setFsAxisValueFormatter(winFormatter.avf); setFsOpen(true); }}
        />
        <TrendChart
          title="告警趋势"
          seriesList={alertChartSeries}
          palette={palette}
          yAxisUnit="次"
          gridColor={chartColors.grid}
          labelColor={chartColors.label}
          onExpand={() => { setFsTitle('告警趋势'); setFsSeriesList(alertChartSeries); setFsPalette(palette); setFsYAxisUnit('次'); setFsValueFormatter(undefined); setFsAxisValueFormatter(undefined); setFsOpen(true); }}
        />
      </div>

      {fsOpen && (
        <div className="fullscreen-overlay show" onClick={() => setFsOpen(false)}>
          <div className="fs-header">
            <span>{fsTitle}</span>
            <span className="fs-close" onClick={() => setFsOpen(false)}>✕</span>
          </div>
          <div className="fs-body" onClick={(e) => e.stopPropagation()}>
            <div className="fs-chart">
              {fsSeriesList.length > 0 && (
                <TimeSeriesChart
                  title={fsTitle}
                  points={fsSeriesList.length === 1 ? fsSeriesList[0].points : []}
                  multiSeries={fsSeriesList.length > 1 ? fsSeriesList : undefined}
                  color={fsSeriesList.length === 1 ? fsSeriesList[0].color : fsPalette[0]}
                  showLegend={fsSeriesList.length > 1}
                  valueFormatter={fsValueFormatter ?? ((v: number) => fmtNum(v))}
                  axisValueFormatter={fsAxisValueFormatter ?? ((v: number) => fmtNum(v))}
                  minY={0}
                  yTickAmount={6}
                  yAxisUnit={fsYAxisUnit}
                  gridColor={chartColors.grid}
                  labelColor={chartColors.label}
                  legendPosition="bottom"
                  legendAlign="center"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
