import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function SourceTable({ sources }: { sources: WfSourceItem[] }) {
  const [ps, setPs] = useState<PageState>({ page: 1, sortBy: 'rows', sortDir: 'desc' });
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'active' | 'quiet'>('active');
  const [groupBy, setGroupBy] = useState<'source' | 'machine'>('source');
  const [machineData, setMachineData] = useState<WfSourceMachineItem[] | null>(null);
  const [machineLoading, setMachineLoading] = useState(false);

  // lazy-load machine data
  useEffect(() => {
    if (groupBy === 'machine' && machineData === null) {
      setMachineLoading(true);
      fetchWfSourceMachines('', '').then((r) => {
        setMachineData(r.data);
        setMachineLoading(false);
      });
    }
  }, [groupBy, machineData]);

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
                      <td className="dim">{(item as WfSourceMachineItem).source_count} 个来源</td>
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
  onClose,
}: {
  ruleName: string;
  totalEmitted: number;
  onClose: () => void;
}) {
  const [items, setItems] = useState<WfStateMachineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWfStateMachines(ruleName).then((r) => {
      if (!cancelled) {
        setItems(r.data.slice(0, 4));
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [ruleName]);

  return (
    <div
      ref={popRef}
      className="sm-popover-global show"
      onMouseLeave={onClose}
      onMouseEnter={() => {}}
    >
      <span className="pop-arrow" />
      <div className="pop-body">
        {loading
          ? <div className="pop-item" style={{ color: 'var(--text-dim)' }}>加载中...</div>
          : items.map((si) => (
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
        {items.length > 0 && (
          <div
            className="pop-item"
            style={{ justifyContent: 'center', color: 'var(--text-dim)', borderTop: '1px solid var(--border-light)', marginTop: 2, paddingTop: 3, fontSize: 10 }}
          >
            点击查看全部
          </div>
        )}
      </div>
    </div>
  );
}

// ── Alert table ──

function AlertTable({ rules }: { rules: WfRuleItem[] }) {
  const [ps, setPs] = useState<PageState>({ page: 1, sortBy: 'emitted', sortDir: 'desc' });
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'active' | 'quiet'>('active');
  const [groupBy, setGroupBy] = useState<'rule' | 'machine'>('rule');
  const [machineData, setMachineData] = useState<WfRuleMachineItem[] | null>(null);
  const [hoverRule, setHoverRule] = useState<string | null>(null);
  const [hoverTrigger, setHoverTrigger] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (groupBy === 'machine' && machineData === null) {
      fetchWfRuleMachines('', '').then((r) => setMachineData(r.data));
    }
  }, [groupBy, machineData]);

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
            {pageItems.map((item, idx) => {
              if (groupBy === 'machine') {
                const m = item as WfRuleMachineItem;
                return (
                  <tr key={m.machine}>
                    <td className="name">{m.machine}</td>
                    <td className="dim">{m.rule_count} 条规则</td>
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
}) {
  const multiSeries = seriesList.length > 1 ? seriesList : undefined;
  const singlePoints = seriesList.length === 1 ? seriesList[0].points : [];
  const color = seriesList.length === 1 ? seriesList[0].color : palette[0];

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
              valueFormatter={(v) => fmtNum(v)}
              axisValueFormatter={(v) => fmtNum(v)}
              minY={0}
              yTickAmount={5}
              gridColor={gridColor}
              labelColor={labelColor}
              hideXAxis
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

export default function WfMonitor() {
  const { theme } = useTheme();
  const palette = useMemo(() => getPalette(theme), [theme]);

  const [pipeline, setPipeline] = useState<WfPipelineResponse | null>(null);
  const [sources, setSources] = useState<WfSourceItem[]>([]);
  const [windows, setWindows] = useState<WfWindowItem[]>([]);
  const [rules, setRules] = useState<WfRuleItem[]>([]);

  const [throughputGroupBy, setThroughputGroupBy] = useState<'source' | 'machine'>('source');
  const [throughputSeries, setThroughputSeries] = useState<NodeTimeSeries[]>([]);

  const [windowMetric, setWindowMetric] = useState('rows');
  const [windowSeries, setWindowSeries] = useState<NodeTimeSeries[]>([]);

  const [alertGroupBy, setAlertGroupBy] = useState<'rule' | 'machine'>('rule');
  const [alertSeries, setAlertSeries] = useState<NodeTimeSeries[]>([]);
  const [fsOpen, setFsOpen] = useState(false);
  const [fsTitle, setFsTitle] = useState('');
  const [fsSeriesList, setFsSeriesList] = useState<Array<{ name: string; points: TimePoint[]; color: string }>>([]);
  const [fsPalette, setFsPalette] = useState<string[]>([]);

  const chartColors = useMemo(() => {
    const isLight = theme === 'light-modern';
    return {
      grid: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)',
      label: isLight ? '#aeaeb2' : '#69655e',
    };
  }, [theme]);

  // initial load
  useEffect(() => {
    loadAll();
  }, []);

  // periodic refresh
  useEffect(() => {
    const timer = setInterval(loadAll, REFRESH_MS);
    return () => clearInterval(timer);
  }, [throughputGroupBy, windowMetric, alertGroupBy]);

  async function loadAll() {
    const [pipelineRes, sourcesRes, windowsRes, rulesRes] = await Promise.all([
      fetchWfPipeline('', ''),
      fetchWfSources('', ''),
      fetchWfWindows('', ''),
      fetchWfRules('', ''),
    ]);
    setPipeline(pipelineRes.data);
    setSources(sourcesRes.data);
    setWindows(windowsRes.data);
    setRules(rulesRes.data);

    // timeseries
    const [tsRes, wsRes, asRes] = await Promise.all([
      fetchWfTimeseriesThroughput('', '', throughputGroupBy),
      fetchWfTimeseriesWindows('', '', windowMetric),
      fetchWfTimeseriesAlerts('', '', alertGroupBy),
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

  if (!pipeline) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>加载中...</div>;
  }

  return (
    <div className="main">
      <PipelineStages pipeline={pipeline} />

      <div className="grid-3">
        <SourceTable sources={sources} />
        <WindowTable windows={windows} />
        <AlertTable rules={rules} />
      </div>

      <div className="grid-3">
        <TrendChart
          title="数据流入"
          seriesList={throughputChartSeries}
          palette={palette}
          gridColor={chartColors.grid}
          labelColor={chartColors.label}
          onExpand={() => { setFsTitle('数据流入'); setFsSeriesList(throughputChartSeries); setFsPalette(palette); setFsOpen(true); }}
        />
        <TrendChart
          title="窗口曲线"
          seriesList={windowChartSeries}
          palette={palette}
          gridColor={chartColors.grid}
          labelColor={chartColors.label}
          metricTabs={[
            { key: 'rows', label: '数据量' },
            { key: 'memory', label: '内存' },
            { key: 'late', label: '迟到' },
          ]}
          activeMetric={windowMetric}
          onMetricChange={setWindowMetric}
          onExpand={() => { setFsTitle('窗口曲线'); setFsSeriesList(windowChartSeries); setFsPalette(palette); setFsOpen(true); }}
        />
        <TrendChart
          title="告警趋势"
          seriesList={alertChartSeries}
          palette={palette}
          gridColor={chartColors.grid}
          labelColor={chartColors.label}
          onExpand={() => { setFsTitle('告警趋势'); setFsSeriesList(alertChartSeries); setFsPalette(palette); setFsOpen(true); }}
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
                  valueFormatter={(v) => fmtNum(v)}
                  axisValueFormatter={(v) => fmtNum(v)}
                  minY={0}
                  yTickAmount={6}
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
