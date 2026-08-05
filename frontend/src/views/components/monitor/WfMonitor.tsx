import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/context/ThemeContext';
import TimeSeriesChart from '@/views/components/monitor/TimeSeriesChart';
import { getPalette } from '@/views/components/monitor/chartPalette';
import {
  fetchWfPipeline,
  fetchWfSources,
  fetchWfSourceMachines,
  fetchWfWindows,
  fetchWfRules,
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
  if (n >= 1e9) return parseFloat((n / 1e9).toFixed(1)) + 'G';
  if (n >= 1e6) return parseFloat((n / 1e6).toFixed(1)) + 'M';
  if (n >= 1e3) return parseFloat((n / 1e3).toFixed(1)) + 'k';
  return Math.round(n).toLocaleString();
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GiB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MiB';
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KiB';
  return n + ' B';
}

const PAGE_SIZE = 10;

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
  const { t } = useTranslation();
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
            <div className="stage-title">{t('monitor.wf.pipeline.receiver.title')}</div>
            <div className="stage-subtitle">{t('monitor.wf.pipeline.receiver.sources', { count: receiver.source_count })}</div>
          </div>
        </div>
        <div className="metric-grid">
          <MRol label={t('monitor.wf.pipeline.receiver.totalRows')} value={fmtNum(receiver.total_rows)} unit={t('monitor.wf.unit.rows')} />
          <MRol label={t('monitor.wf.pipeline.receiver.routeErrors')} value={fmtNum(receiver.route_errors)} unit={t('monitor.wf.unit.times')} color={errColor} />
          <MRol label={t('monitor.wf.pipeline.receiver.rate')} value={fmtNum(receiver.rate_rows_per_sec)} unit={t('monitor.wf.unit.rowsPerSec')} />
        </div>
      </div>

      <div className="stage">
        <div className="stage-head">
          <div className="stage-icon win">⊞</div>
          <div>
            <div className="stage-title">{t('monitor.wf.pipeline.window.title')}</div>
            <div className="stage-subtitle">{t('monitor.wf.pipeline.window.windows', { count: window.window_count })}</div>
          </div>
        </div>
        <div className="metric-grid">
          <MRol label={t('monitor.wf.pipeline.window.totalRows')} value={fmtNum(window.total_rows)} unit={t('monitor.wf.unit.rows')} />
          <MRol label={t('monitor.wf.pipeline.window.memory')} value={fmtBytes(window.total_memory_bytes)} />
          <MRol label={t('monitor.wf.pipeline.window.lateDropped')} value={fmtNum(window.late_dropped)} unit={t('monitor.wf.unit.rows')} color={lateColor} />
        </div>
      </div>

      <div className="stage">
        <div className="stage-head">
          <div className="stage-icon rul">◎</div>
          <div>
            <div className="stage-title">{t('monitor.wf.pipeline.rule.title')}</div>
            <div className="stage-subtitle">{t('monitor.wf.pipeline.rule.summary', { count: rule.rule_count, rate: rule.hit_rate_pct.toFixed(1) })}</div>
          </div>
        </div>
        <div className="metric-grid">
          <MRol label={t('monitor.wf.pipeline.rule.instances')} value={fmtNum(rule.total_state_machines)} unit={t('monitor.wf.unit.times')} />
          <MRol label={t('monitor.wf.pipeline.rule.emitted')} value={fmtNum(rule.total_emitted)} unit={t('monitor.wf.unit.rows')} />
          <MRol label={t('monitor.wf.pipeline.rule.sendFailed')} value={fmtNum(rule.send_failed)} unit={t('monitor.wf.unit.times')} color={failColor} />
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
  const { t } = useTranslation();
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
      <span className="page-info">{t('monitor.wf.totalRecords', { total })}</span>
    </div>
  );
}

// ── Source table ──

function SourceTable({ sources, timeRange }: { sources: WfSourceItem[]; timeRange: { start: string; end: string } }) {
  const { t } = useTranslation();
  const [ps, setPs] = useState<PageState>({ page: 1, sortBy: 'rows', sortDir: 'desc' });
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'active' | 'quiet'>('active');
  const [groupBy, setGroupBy] = useState<'source' | 'machine'>('source');
  const [machineData, setMachineData] = useState<WfSourceMachineItem[] | null>(null);
  const [machineLoading, setMachineLoading] = useState(false);
  const machineGenRef = useRef(0);

  // lazy-load machine data, re-fetch on time change; only show loading on initial fetch
  useEffect(() => {
    if (groupBy === 'machine') {
      const gen = ++machineGenRef.current;
      if (!machineData) setMachineLoading(true);
      fetchWfSourceMachines(timeRange.start, timeRange.end).then((r) => {
        if (gen >= machineGenRef.current) {
          setMachineData(r.data);
          setMachineLoading(false);
        }
      }).catch(() => {
        if (gen >= machineGenRef.current) setMachineLoading(false);
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
      if (f === 'lag') return s.consumer_lag;
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
        <span>{t('monitor.wf.sourceTable.title')}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="pill-toggle">
            <span className="pill-slider" />
            <span
              className={'pill-option' + (groupBy === 'source' ? ' active' : '')}
              onClick={() => { setGroupBy('source'); resetPage(); }}
            >
              {t('monitor.wf.sourceTable.source')}
            </span>
            <span
              className={'pill-option' + (groupBy === 'machine' ? ' active' : '')}
              onClick={() => { setGroupBy('machine'); resetPage(); }}
            >
              {t('monitor.wf.sourceTable.machine')}
            </span>
          </span>
          <span className="filter-toggle">
            <span
              className={'ft-btn' + (mode === 'active' ? ' active' : '')}
              onClick={() => { setMode('active'); resetPage(); }}
            >
              {t('monitor.wf.sourceTable.active')}
            </span>
            <span
              className={'ft-btn' + (mode === 'quiet' ? ' active' : '')}
              onClick={() => { setMode('quiet'); resetPage(); }}
            >
              {t('monitor.wf.sourceTable.silent')}
            </span>
          </span>
          <input
            className="search-input"
            placeholder={t('monitor.wf.sourceTable.search')}
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetPage(); }}
          />
        </span>
      </div>
      <div className="panel-body">
        {machineLoading ? (
          <div style={{ padding: 12, color: 'var(--wf-text-dim)', fontSize: 12 }}>{t('monitor.wf.loading')}</div>
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
                      {sortHeader(t('monitor.wf.sourceTable.colMachine'), 'name', ps)}
                      {sortHeader(t('monitor.wf.sourceTable.colSourceCount'), 'count', ps, true)}
                      {sortHeader(t('monitor.wf.sourceTable.colRows'), 'rows', ps, true)}
                      {sortHeader(t('monitor.wf.sourceTable.colErrors'), 'errs', ps, true)}
                    </>
                  )
                  : (
                    <>
                      {sortHeader(t('monitor.wf.sourceTable.colName'), 'name', ps)}
                      {sortHeader(t('monitor.wf.sourceTable.colType'), 'type', ps)}
                      {sortHeader(t('monitor.wf.sourceTable.colRows'), 'rows', ps, true)}
                      {sortHeader(t('monitor.wf.sourceTable.colErrors'), 'errs', ps, true)}
                      {sortHeader(t('monitor.wf.sourceTable.colLag'), 'lag', ps, true)}
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
                      <td className="num" style={{ color: (item as WfSourceMachineItem).route_errors > 0 ? 'var(--warning)' : 'var(--wf-text-dim)' }}>
                        {(item as WfSourceMachineItem).route_errors}
                      </td>
                    </tr>
                  )
                  : (
                    <tr key={(item as WfSourceItem).name}>
                      <td className="name">{(item as WfSourceItem).name}</td>
                      <td className="dim">{(item as WfSourceItem).type}</td>
                      <td className="num">{fmtNum(item.rows)}</td>
                      <td className="num" style={{ color: (item as WfSourceItem).route_errors > 0 ? 'var(--warning)' : 'var(--wf-text-dim)' }}>
                        {(item as WfSourceItem).route_errors}
                      </td>
                      <td className="num" style={{ color: (item as WfSourceItem).consumer_lag > 0 ? 'var(--warning)' : 'var(--wf-text-dim)' }}>
                        {fmtNum((item as WfSourceItem).consumer_lag)}
                      </td>
                    </tr>
                  ),
              )}
              {Array.from({ length: pad }, (_, i) => (
                <tr key={`pad-${i}`} className="pad-row">
                  <td colSpan={11}>&nbsp;</td>
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
  const { t } = useTranslation();
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
        <span>{t('monitor.wf.windowTable.title')}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="filter-toggle">
            <span className={'ft-btn' + (mode === 'active' ? ' active' : '')} onClick={() => { setMode('active'); resetPage(); }}>{t('monitor.wf.windowTable.active')}</span>
            <span className={'ft-btn' + (mode === 'quiet' ? ' active' : '')} onClick={() => { setMode('quiet'); resetPage(); }}>{t('monitor.wf.windowTable.silent')}</span>
          </span>
          <input
            className="search-input"
            placeholder={t('monitor.wf.windowTable.search')}
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
              {sortHeader(t('monitor.wf.windowTable.colName'), 'name', ps)}
              {sortHeader(t('monitor.wf.windowTable.colRows'), 'rows', ps, true)}
              {sortHeader(t('monitor.wf.windowTable.colLate'), 'late', ps, true)}
              {sortHeader(t('monitor.wf.windowTable.colMemory'), 'mem', ps)}
              {sortHeader(t('monitor.wf.windowTable.colPercent'), 'pct', ps)}
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
                  <td className="num" style={{ color: w.late_dropped > 0 ? 'var(--warning)' : 'var(--wf-text-dim)' }}>{fmtNum(w.late_dropped)}</td>
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
  totalInstances,
  stateMachines,
  triggerEl,
  startFullscreen,
  onClose,
  onClearCloseTimer,
}: {
  ruleName: string;
  totalInstances: number;
  stateMachines: WfStateMachineItem[];
  triggerEl: HTMLElement;
  startFullscreen?: boolean;
  onClose: () => void;
  onClearCloseTimer: () => void;
}) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ top: number; left: number; dir: 'above' | 'below'; arrowX: number }>({ top: 0, left: 0, dir: 'above', arrowX: 50 });
  const [visible, setVisible] = useState(false);
  const [fsOpen, setFsOpen] = useState(Boolean(startFullscreen));
  const popRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allItems = stateMachines;
  const loading = false;

  // position popover relative to trigger
  useEffect(() => {
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
  }, [triggerEl, allItems]);

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

  useEffect(() => {
    if (startFullscreen) setFsOpen(true);
  }, [startFullscreen]);

  const handleMouseEnter = () => {
    onClearCloseTimer();
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const handleMouseLeave = () => {
    if (fsOpen) return;
    hideTimer.current = setTimeout(onClose, 150);
  };

  const shown = allItems.slice(0, 4);
  const totalItems = allItems.length;
  const closeFullscreen = () => {
    setFsOpen(false);
    onClose();
  };

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
            ? <div className="pop-item" style={{ color: 'var(--wf-text-dim)' }}>{t('monitor.wf.loading')}</div>
            : totalItems === 0
              ? <div className="pop-item" style={{ color: 'var(--wf-text-dim)', fontSize: 11 }}>
                  {totalInstances > 0
                    ? t('monitor.wf.popover.noAlerts', { count: totalInstances })
                    : t('monitor.wf.popover.noInstances')}
                </div>
              : (
                <>
                  {shown.map((si) => (
                    <div className="pop-item" key={si.scope_key}>
                      <span className="pop-name">{si.scope_key}</span>
                      <span className="pop-val">{fmtNum(si.emitted)}</span>
                    </div>
                  ))}
                  {totalItems > 4 && (
                    <div
                      className="pop-item"
                      style={{ justifyContent: 'center', color: 'var(--wf-text-dim)', borderTop: '1px solid var(--wf-border-light)', marginTop: 2, paddingTop: 3, fontSize: 10, cursor: 'pointer' }}
                      onClick={() => setFsOpen(true)}
                    >
                      {t('monitor.wf.popover.viewAll')}
                    </div>
                  )}
                </>
              )}
        </div>
      </div>

      {fsOpen && (
        <div className="fullscreen-overlay show sm-dialog-overlay" onClick={closeFullscreen}>
          <div className="sm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="sm-dialog-head">
              <div className="sm-dialog-title-wrap">
                <span className="sm-dialog-kicker">{t('monitor.wf.alertTable.colInstances')}</span>
                <span className="sm-dialog-title" title={ruleName}>{ruleName}</span>
              </div>
              <div className="sm-dialog-head-actions">
                <span className="sm-dialog-count">{t('monitor.wf.popover.instances', { count: totalItems })}</span>
                <button className="sm-dialog-close" type="button" onClick={closeFullscreen} aria-label="Close">✕</button>
              </div>
            </div>
            <div className="sm-dialog-columns">
              <span>#</span>
              <span>{t('monitor.wf.alertTable.colInstances')}</span>
              <span>{t('monitor.wf.alertTable.colEmitted')}</span>
            </div>
            <div className="sm-dialog-list">
              {allItems.map((si, index) => (
                <div className="sm-dialog-row" key={si.scope_key}>
                  <span className="sm-dialog-rank">{String(index + 1).padStart(2, '0')}</span>
                  <div className="sm-dialog-instance">
                    <span className="sm-dialog-name" title={si.scope_key}>{si.scope_key}</span>
                  </div>
                  <span className="sm-dialog-value">{fmtNum(si.emitted)}</span>
                </div>
              ))}
              {allItems.length === 0 && (
                <div className="sm-dialog-empty">{t('monitor.wf.popover.noInstances')}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Alert table ──

function AlertTable({ rules, timeRange }: { rules: WfRuleItem[]; timeRange: { start: string; end: string } }) {
  const { t } = useTranslation();
  const [ps, setPs] = useState<PageState>({ page: 1, sortBy: 'emitted', sortDir: 'desc' });
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'active' | 'quiet'>('active');
  const [groupBy, setGroupBy] = useState<'rule' | 'machine'>('rule');
  const [machineData, setMachineData] = useState<WfRuleMachineItem[] | null>(null);
  const [hoverRule, setHoverRule] = useState<string | null>(null);
  const [hoverTrigger, setHoverTrigger] = useState<HTMLElement | null>(null);
  const [openInstancesDirectly, setOpenInstancesDirectly] = useState(false);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverCloseTimer = () => {
    if (hoverCloseTimerRef.current !== null) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  };

  const scheduleHoverClose = () => {
    if (openInstancesDirectly) return;
    clearHoverCloseTimer();
    hoverCloseTimerRef.current = setTimeout(() => setHoverRule(null), 150);
  };

  const alertMachineGenRef = useRef(0);

  useEffect(() => {
    if (groupBy === 'machine') {
      const gen = ++alertMachineGenRef.current;
      fetchWfRuleMachines(timeRange.start, timeRange.end).then((r) => {
        if (gen >= alertMachineGenRef.current) setMachineData(r.data);
      }).catch(() => {});
    }
  }, [groupBy, timeRange.start, timeRange.end]);

  // rule mode
  const ruleFiltered = useMemo(() => {
    let list = rules.filter((r) => (r.emitted > 0 || r.matched > 0) === (mode === 'active'));
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((r) => r.name.toLowerCase().includes(q));
    }
    return sortItems(list, ps.sortBy, ps.sortDir, (r, f) => {
      if (f === 'name') return r.name;
      if (f === 'instances') return r.instances;
      if (f === 'matched') return r.matched;
      return r.emitted;
    });
  }, [rules, mode, search, ps]);

  // machine mode
  const macFiltered = useMemo(() => {
    const list = (machineData || []).filter((m) => (m.emitted > 0 || m.matched > 0) === (mode === 'active'));
    return sortItems(list, ps.sortBy, ps.sortDir, (m, f) => {
      if (f === 'name') return m.machine;
      if (f === 'count') return m.rule_count;
      if (f === 'matched') return m.matched;
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
        <span>{t('monitor.wf.alertTable.title')}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="pill-toggle">
            <span className="pill-slider" />
            <span className={'pill-option' + (groupBy === 'rule' ? ' active' : '')} onClick={() => { setGroupBy('rule'); resetPage(); }}>{t('monitor.wf.alertTable.rule')}</span>
            <span className={'pill-option' + (groupBy === 'machine' ? ' active' : '')} onClick={() => { setGroupBy('machine'); resetPage(); }}>{t('monitor.wf.alertTable.machine')}</span>
          </span>
          <span className="filter-toggle">
            <span className={'ft-btn' + (mode === 'active' ? ' active' : '')} onClick={() => { setMode('active'); resetPage(); }}>{t('monitor.wf.alertTable.active')}</span>
            <span className={'ft-btn' + (mode === 'quiet' ? ' active' : '')} onClick={() => { setMode('quiet'); resetPage(); }}>{t('monitor.wf.alertTable.silent')}</span>
          </span>
          <input
            className="search-input"
            placeholder={t('monitor.wf.alertTable.search')}
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
                    {sortHeader(t('monitor.wf.alertTable.colMachine'), 'name', ps)}
                    {sortHeader(t('monitor.wf.alertTable.colMatched'), 'matched', ps, true)}
                    {sortHeader(t('monitor.wf.alertTable.colRuleCount'), 'count', ps, true)}
                    {sortHeader(t('monitor.wf.alertTable.colEmitted'), 'emitted', ps, true)}
                  </>
                )
                : (
                  <>
                    {sortHeader(t('monitor.wf.alertTable.colName'), 'name', ps)}
                    {sortHeader(t('monitor.wf.alertTable.colMatched'), 'matched', ps, true)}
                    {sortHeader(t('monitor.wf.alertTable.colEmitted'), 'emitted', ps, true)}
                    {sortHeader(t('monitor.wf.alertTable.colInstances'), 'instances', ps, true)}
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
                    <td className="num">{fmtNum(m.matched)}</td>
                    <td className="num">{m.rule_count}</td>
                    <td className="num" style={{ color: m.emitted > 0 ? 'var(--orange)' : 'var(--wf-text-dim)' }}>{fmtNum(m.emitted)}</td>
                  </tr>
                );
              }
              const r = item as WfRuleItem;
              const cell =
                r.instances > 0 ? (
                  <span
                    className="sm-trigger"
                    data-rule={r.name}
                    onClick={(e) => {
                      clearHoverCloseTimer();
                      setOpenInstancesDirectly(true);
                      setHoverRule(r.name);
                      setHoverTrigger(e.currentTarget as HTMLElement);
                    }}
                    onMouseEnter={(e) => {
                      clearHoverCloseTimer();
                      setOpenInstancesDirectly(false);
                      setHoverRule(r.name);
                      setHoverTrigger(e.currentTarget as HTMLElement);
                    }}
                    onMouseLeave={scheduleHoverClose}
                  >
                    {r.instances}
                  </span>
                ) : (
                  <span>{r.instances}</span>
                );
              return (
                <tr key={r.name}>
                  <td className="name">{r.name}</td>
                  <td className="num">{fmtNum(r.matched)}</td>
                  <td className="num" style={{ color: r.emitted > 0 ? 'var(--orange)' : 'var(--wf-text-dim)' }}>{fmtNum(r.emitted)}</td>
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
      {hoverRule && hoverTrigger && (() => {
        const rule = rules.find((r) => r.name === hoverRule);
        return (
        <SmPopover
          ruleName={hoverRule}
          totalInstances={rule?.instances || 0}
          stateMachines={rule?.state_machines || []}
          triggerEl={hoverTrigger}
          startFullscreen={openInstancesDirectly}
          onClose={() => {
            setHoverRule(null);
            setOpenInstancesDirectly(false);
          }}
          onClearCloseTimer={clearHoverCloseTimer}
        />
        );
      })()}
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
  xMin,
  xMax,
  loading,
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
  xMin?: number;
  xMax?: number;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const multiSeries = seriesList.length > 0 ? seriesList : undefined;
  const singlePoints = seriesList.length === 1 ? seriesList[0].points : [];
  const color = seriesList.length === 1 ? seriesList[0].color : palette[0];
  const ceil2 = useMemo(() => (v: number) => (Math.ceil(v * 100) / 100).toString(), []);
  const vf = vfProp ?? ceil2;
  const avf = avfProp ?? ceil2;

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
            <span className="expand-btn" onClick={onExpand} title={t('monitor.wf.chart.fullscreen')}>
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
              showLegend={seriesList.length > 0}
              valueFormatter={vf}
              axisValueFormatter={avf}
              minY={0}
              yTickAmount={5}
              gridColor={gridColor}
              labelColor={labelColor}
              yAxisUnit={yAxisUnit}
              legendPosition="bottom"
              legendAlign="center"
              legendFontSize="10px"
              legendMarkerSize={5}
              xMin={xMin}
              xMax={xMax}
            />
          ) : loading ? (
            <div style={{ padding: 12, color: 'var(--wf-text-dim)', fontSize: 12 }}>{t('monitor.wf.loading')}</div>
          ) : (
            <div style={{ padding: 12, color: 'var(--wf-text-dim)', fontSize: 12 }}>{t('monitor.wf.chart.noData')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main WfMonitor ──

const EMPTY_PIPELINE: WfPipelineResponse = {
  generated_at: '',
  receiver: { total_rows: 0, rate_rows_per_sec: 0, route_errors: 0, source_count: 0 },
  window: { window_count: 0, total_rows: 0, total_memory_bytes: 0, late_dropped: 0 },
  rule: { rule_count: 0, total_state_machines: 0, hit_rate_pct: 0, total_emitted: 0, send_failed: 0, e2e_p99_ms: 0, total_matched: 0 },
};

export default function WfMonitor({ startTime, endTime, refreshIntervalSec, active = true }: { startTime: string; endTime: string; refreshIntervalSec: number; active?: boolean }) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const palette = useMemo(() => getPalette(theme), [theme]);

  const [pipeline, setPipeline] = useState<WfPipelineResponse>(EMPTY_PIPELINE);
  const [sources, setSources] = useState<WfSourceItem[]>([]);
  const [windows, setWindows] = useState<WfWindowItem[]>([]);
  const [rules, setRules] = useState<WfRuleItem[]>([]);
  const [fetchError, setFetchError] = useState('');

  const [throughputGroupBy] = useState<'source' | 'machine'>('source');
  const [throughputSeries, setThroughputSeries] = useState<NodeTimeSeries[]>([]);

  const [windowMetric, setWindowMetric] = useState('rows');
  const [windowSeries, setWindowSeries] = useState<NodeTimeSeries[]>([]);

  const [alertGroupBy] = useState<'rule' | 'machine'>('rule');
  const [alertMetric, setAlertMetric] = useState('alertcount');
  const [alertSeries, setAlertSeries] = useState<NodeTimeSeries[]>([]);
  const [timeseriesLoading, setTimeseriesLoading] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);
  const [fsChartKey, setFsChartKey] = useState<'throughput' | 'window' | 'alerts'>('throughput');
  const [fsTitle, setFsTitle] = useState('');
  const [fsYAxisUnit, setFsYAxisUnit] = useState<string | undefined>(undefined);
  const [fsValueFormatter, setFsValueFormatter] = useState<((v: number) => string) | undefined>(undefined);
  const [fsAxisValueFormatter, setFsAxisValueFormatter] = useState<((v: number) => string) | undefined>(undefined);
  const [fsMetricTabs, setFsMetricTabs] = useState<{ key: string; label: string }[] | undefined>(undefined);
  const [fsActiveMetric, setFsActiveMetric] = useState<string | undefined>(undefined);

  const chartColors = useMemo(() => {
    const isLight = theme === 'light-modern';
    return {
      grid: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)',
      label: isLight ? '#aeaeb2' : '#69655e',
    };
  }, [theme]);

  // Recreate on every render so SourceTable/AlertTable get fresh values;
  // the loading cycle only depends on duration, not on this object.
  const timeRange = useMemo(() => ({ start: startTime, end: endTime }), [startTime, endTime]);

  const windowMetricRef = useRef(windowMetric);
  windowMetricRef.current = windowMetric;
  const alertMetricRef = useRef(alertMetric);
  alertMetricRef.current = alertMetric;

  // Track the time-range duration in ms. Updated on every render from props,
  // but only changes meaningfully when the user picks a different range.
  // Auto-refresh slides the window but keeps the same duration, so we avoid
  // resetting the loading cycle on every parent update.
  const durationMsRef = useRef(0);
  const prevDurationMsRef = useRef(0);
  {
    const startMs = new Date(startTime).getTime();
    const endMs = new Date(endTime).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      durationMsRef.current = endMs - startMs;
    }
  }

  const loadGenRef = useRef(0);

  // 查询窗口和图表 x 轴保持一致：用 Date.now() 而非父组件 props，
  // 避免 auto-refresh 时 props 更新滞后导致图表左侧出现空白。
  const [chartXRange, setChartXRange] = useState(() => ({
    xMin: new Date(startTime).getTime(),
    xMax: new Date(endTime).getTime(),
  }));

  // Periodic refresh: the interval runs continuously without being reset
  // on every parent auto-refresh. loadAll always uses Date.now() for the
  // query window, so it stays fresh regardless of props.
  useEffect(() => {
    loadAll();
    if (refreshIntervalSec <= 0) return;
    const timer = setInterval(loadAll, refreshIntervalSec * 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshIntervalSec]);

  // When the tab becomes visible (switching from wparse to wfusion),
  // immediately fetch fresh data instead of waiting for the next auto-refresh.
  // Skip the initial mount to avoid double-fetch with the [refreshIntervalSec] effect.
  const activeFirstRenderRef = useRef(true);
  useEffect(() => {
    if (activeFirstRenderRef.current) {
      activeFirstRenderRef.current = false;
      return;
    }
    if (active) {
      loadAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // When the user intentionally changes the time range (different duration),
  // trigger an immediate fetch. Auto-refresh keeps the same duration so this
  // does NOT fire on every parent update.
  useEffect(() => {
    const curr = durationMsRef.current;
    if (prevDurationMsRef.current !== 0 && prevDurationMsRef.current !== curr) {
      loadAll();
    }
    prevDurationMsRef.current = curr;
  }, [startTime, endTime]);

  // 窗口指标切换时立即拉取时序
  // Uses its own generation counter so it never invalidates in-flight loadAll responses.
  const windowMetricGenRef = useRef(0);
  useEffect(() => {
    const gen = ++windowMetricGenRef.current;
    const durationMs = durationMsRef.current;
    const now = Date.now();
    const e = new Date(now).toISOString();
    const s = new Date(now - (durationMs > 0 ? durationMs : 5 * 60 * 1000)).toISOString();
    fetchWfTimeseriesWindows(s, e, windowMetric)
      .then((res) => { if (gen >= windowMetricGenRef.current) setWindowSeries(res.data); })
      .catch(() => {});
  }, [windowMetric]);

  // 告警指标切换时立即拉取时序（复用 loadAll 的 generation counter，避免竞态）
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertMetric]);

  async function loadAll() {
    const gen = ++loadGenRef.current;
    const durationMs = durationMsRef.current;
    const now = Date.now();
    const e = new Date(now).toISOString();
    const s = new Date(now - (durationMs > 0 ? durationMs : 5 * 60 * 1000)).toISOString();

    if (gen >= loadGenRef.current) setFetchError('');

    // 阶段 1：快照数据独立请求，每个到达即渲染，pipeline 最先到达则最快展示页面框架
    let phase1Errors = 0;
    const p1 = fetchWfPipeline(s, e).then((res) => { if (gen >= loadGenRef.current) setPipeline(res.data); }).catch(() => { phase1Errors++; });
    const p2 = fetchWfSources(s, e).then((res) => { if (gen >= loadGenRef.current) setSources(res.data); }).catch(() => { phase1Errors++; });
    const p3 = fetchWfWindows(s, e).then((res) => { if (gen >= loadGenRef.current) setWindows(res.data); }).catch(() => { phase1Errors++; });
    const p4 = fetchWfRules(s, e).then((res) => { if (gen >= loadGenRef.current) setRules(res.data); }).catch(() => { phase1Errors++; });
    await Promise.all([p1, p2, p3, p4]);

    if (gen >= loadGenRef.current && phase1Errors === 4) {
      setFetchError(t('monitor.wf.error.fetchFailed'));
      return;
    }

    // 阶段 2：时序数据（range query，可能较慢），批量更新
    if (gen >= loadGenRef.current) setTimeseriesLoading(true);
    const [tsRes, wsRes, asRes] = await Promise.allSettled([
      fetchWfTimeseriesThroughput(s, e, throughputGroupBy),
      fetchWfTimeseriesWindows(s, e, windowMetricRef.current),
      fetchWfTimeseriesAlerts(s, e, alertGroupBy, alertMetricRef.current),
    ]);
    if (gen >= loadGenRef.current) {
      if (tsRes.status === 'fulfilled') setThroughputSeries(tsRes.value.data);
      if (wsRes.status === 'fulfilled') setWindowSeries(wsRes.value.data);
      if (asRes.status === 'fulfilled') setAlertSeries(asRes.value.data);
      setChartXRange({ xMin: now - (durationMs > 0 ? durationMs : 5 * 60 * 1000), xMax: now });
      setTimeseriesLoading(false);
    }
  }

  const MAX_CHART_SERIES = 20;

  // build chart series (skip silent nodes, sort desc by primary metric)
  const throughputChartSeries = useMemo(() => {
    const valMap = new Map(sources.map((s) => [s.name, s.rows]));
    const active = throughputSeries
      .filter((s) => s.log_rate_eps.some((p) => p.value != null && p.value !== 0))
      .sort((a, b) => (valMap.get(b.node_id) ?? 0) - (valMap.get(a.node_id) ?? 0));
    return active.slice(0, MAX_CHART_SERIES).map((s, i) => ({
      name: s.node_id,
      points: s.log_rate_eps,
      color: palette[i % palette.length],
    }));
  }, [throughputSeries, palette, sources]);

  const windowChartSeries = useMemo(() => {
    const valMap = new Map(windows.map((w) => {
      const v = windowMetric === 'memory' ? w.memory_bytes : windowMetric === 'late' ? w.late_dropped : w.rows;
      return [w.name, v] as const;
    }));
    const active = windowSeries
      .filter((s) => s.log_rate_eps.some((p) => p.value != null && p.value !== 0))
      .sort((a, b) => (valMap.get(b.node_id) ?? 0) - (valMap.get(a.node_id) ?? 0));
    return active.slice(0, MAX_CHART_SERIES).map((s, i) => ({
      name: s.node_id,
      points: s.log_rate_eps,
      color: palette[i % palette.length],
    }));
  }, [windowSeries, palette, windows, windowMetric]);

  const alertChartSeries = useMemo(() => {
    const valMap = new Map(rules.map((r) => [r.name, r.emitted]));
    const active = alertSeries
      .filter((s) => s.log_rate_eps.some((p) => p.value != null && p.value !== 0))
      .sort((a, b) => (valMap.get(b.node_id) ?? 0) - (valMap.get(a.node_id) ?? 0));
    return active.slice(0, MAX_CHART_SERIES).map((s, i) => ({
      name: s.node_id,
      points: s.log_rate_eps,
      color: palette[i % palette.length],
    }));
  }, [alertSeries, palette, rules]);

  const fsSeriesList = useMemo(() => {
    if (fsChartKey === 'throughput') return throughputChartSeries;
    if (fsChartKey === 'window') return windowChartSeries;
    return alertChartSeries;
  }, [fsChartKey, throughputChartSeries, windowChartSeries, alertChartSeries]);

  const winFormatter = useMemo(() => {
    if (windowMetric === 'memory') {
      return { vf: (v: number) => fmtBytes(v), avf: (v: number) => fmtBytes(v), unit: undefined };
    }
    return { vf: (v: number) => fmtNum(v), avf: (v: number) => fmtNum(v), unit: t('monitor.wf.unit.rows') as string | undefined };
  }, [windowMetric, t]);

  const fsFormatter = useMemo(() => {
    if (fsChartKey === 'window') {
      return { vf: winFormatter.vf, avf: winFormatter.avf, unit: winFormatter.unit };
    }
    return { vf: fsValueFormatter, avf: fsAxisValueFormatter, unit: fsYAxisUnit };
  }, [fsChartKey, winFormatter, fsValueFormatter, fsAxisValueFormatter, fsYAxisUnit]);

  return (
    <div className="main">
      {fetchError && (
        <div className="wf-error-banner">{fetchError}</div>
      )}
      <PipelineStages pipeline={pipeline} />

      <div className="grid-3">
        <SourceTable sources={sources} timeRange={timeRange} />
        <WindowTable windows={windows} />
        <AlertTable rules={rules} timeRange={timeRange} />
      </div>

      <div className="grid-3">
        <TrendChart
          title={t('monitor.wf.chart.throughput')}
          seriesList={throughputChartSeries}
          palette={palette}
          yAxisUnit="eps"
          gridColor={chartColors.grid}
          labelColor={chartColors.label}
          xMin={chartXRange.xMin}
          xMax={chartXRange.xMax}
          onExpand={() => { setFsChartKey('throughput'); setFsTitle(t('monitor.wf.chart.throughput')); setFsYAxisUnit('eps'); setFsValueFormatter(undefined); setFsAxisValueFormatter(undefined); setFsMetricTabs(undefined); setFsActiveMetric(undefined); setFsOpen(true); }}
          loading={timeseriesLoading}
        />
        <TrendChart
          title={t('monitor.wf.chart.window')}
          seriesList={windowChartSeries}
          palette={palette}
          yAxisUnit={winFormatter.unit}
          valueFormatter={winFormatter.vf}
          axisValueFormatter={winFormatter.avf}
          gridColor={chartColors.grid}
          labelColor={chartColors.label}
          xMin={chartXRange.xMin}
          xMax={chartXRange.xMax}
          metricTabs={[
            { key: 'rows', label: t('monitor.wf.chart.metricRows') },
            { key: 'memory', label: t('monitor.wf.chart.metricMemory') },
            { key: 'late', label: t('monitor.wf.chart.metricLate') },
          ]}
          activeMetric={windowMetric}
          onMetricChange={setWindowMetric}
          onExpand={() => { setFsChartKey('window'); setFsTitle(t('monitor.wf.chart.window')); setFsYAxisUnit(winFormatter.unit); setFsValueFormatter(undefined); setFsAxisValueFormatter(undefined); setFsMetricTabs([{ key: 'rows', label: t('monitor.wf.chart.metricRows') }, { key: 'memory', label: t('monitor.wf.chart.metricMemory') }, { key: 'late', label: t('monitor.wf.chart.metricLate') }]); setFsActiveMetric(windowMetric); setFsOpen(true); }}
          loading={timeseriesLoading}
        />
        <TrendChart
          title={t('monitor.wf.chart.alerts')}
          seriesList={alertChartSeries}
          palette={palette}
          yAxisUnit={t('monitor.wf.unit.times')}
          gridColor={chartColors.grid}
          labelColor={chartColors.label}
          xMin={chartXRange.xMin}
          xMax={chartXRange.xMax}
          metricTabs={[
            { key: 'alertcount', label: t('monitor.wf.chart.metricEmitted') },
            { key: 'alertmatched', label: t('monitor.wf.chart.metricMatched') },
          ]}
          activeMetric={alertMetric}
          onMetricChange={setAlertMetric}
          onExpand={() => { setFsChartKey('alerts'); setFsTitle(t('monitor.wf.chart.alerts')); setFsYAxisUnit(t('monitor.wf.unit.times')); setFsValueFormatter(undefined); setFsAxisValueFormatter(undefined); setFsMetricTabs([{ key: 'alertcount', label: t('monitor.wf.chart.metricEmitted') }, { key: 'alertmatched', label: t('monitor.wf.chart.metricMatched') }]); setFsActiveMetric(alertMetric); setFsOpen(true); }}
          loading={timeseriesLoading}
        />
      </div>

      {fsOpen && (
        <div className="fullscreen-overlay show" onClick={() => setFsOpen(false)}>
          <div className="fs-header">
            <span>{fsTitle}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {fsMetricTabs && (
                <span className="chart-tabs">
                  {fsMetricTabs.map((t) => (
                    <span
                      key={t.key}
                      className={`ctab${t.key === fsActiveMetric ? ' active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFsActiveMetric(t.key);
                        setWindowMetric(t.key);
                      }}
                    >
                      {t.label}
                    </span>
                  ))}
                </span>
              )}
              <span className="fs-close" onClick={(e) => { e.stopPropagation(); setFsOpen(false); }}>✕</span>
            </span>
          </div>
          <div className="fs-body" onClick={(e) => e.stopPropagation()}>
            <div className="fs-chart">
              {fsSeriesList.length > 0 && (
                <TimeSeriesChart
                  title={fsTitle}
                  points={fsSeriesList.length === 1 ? fsSeriesList[0].points : []}
                  multiSeries={fsSeriesList.length > 0 ? fsSeriesList : undefined}
                  color={fsSeriesList.length === 1 ? fsSeriesList[0].color : palette[0]}
                  showLegend={fsSeriesList.length > 0}
                  valueFormatter={fsFormatter.vf ?? ((v: number) => (Math.ceil(v * 100) / 100).toString())}
                  axisValueFormatter={fsFormatter.avf ?? ((v: number) => (Math.ceil(v * 100) / 100).toString())}
                  minY={0}
                  yTickAmount={6}
                  yAxisUnit={fsFormatter.unit}
                  gridColor={chartColors.grid}
                  labelColor={chartColors.label}
                  hideXAxis={false}
                  legendPosition="bottom"
                  legendAlign="center"
                  xMin={chartXRange.xMin}
                  xMax={chartXRange.xMax}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
