import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfigProvider from "antd/es/config-provider";
import DatePicker from "antd/es/date-picker";
import antdZhCN from "antd/es/locale/zh_CN";
import dayjs, { type Dayjs } from "dayjs";
import "dayjs/locale/zh-cn";
import {
  applyMetricsToSnapshot,
  collectAllNodeIds,
  fmtCount,
  fmtPercentWithMin,
  fmtRate,
} from "../../components/monitor/flowHelpers";
import TimeSeriesChart from "../../components/monitor/TimeSeriesChart";
import {
  exportMissedLogs,
  fetchMissedLogs,
  fetchMetrics,
  fetchNodeDetail,
  fetchNodeTimeSeries,
  fetchSnapshot,
} from "../../services/monitor";
import type {
  LayerSnapshot,
  NodeDetail,
  NodeTimeSeries,
  VlogRecord,
} from "../../types/monitor";
import "antd/dist/reset.css";
import "./index.css";

const QUICK_RANGES = [
  { key: "1m", label: "最近 1 分钟", minutes: 1 },
  { key: "5m", label: "最近 5 分钟", minutes: 5 },
  { key: "1h", label: "最近 1 小时", minutes: 60 },
  { key: "6h", label: "最近 6 小时", minutes: 360 },
  { key: "24h", label: "最近 24 小时", minutes: 1440 },
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "week", label: "本周" },
] as const;
const MISS_PAGE_SIZE = 10;
const { RangePicker } = DatePicker;
dayjs.locale("zh-cn");

type LegendType =
  | "source"
  | "package"
  | "log"
  | "group"
  | "sink"
  | "miss"
  | null;
type ParseSearchItem =
  | {
      key: string;
      type: "package";
      packageId: string;
      packageName: string;
      label: string;
    }
  | {
      key: string;
      type: "log";
      packageId: string;
      packageName: string;
      logId: string;
      logName: string;
      label: string;
    };

function toIsoByMinutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function toDateFromIso(v: string) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function formatLocalDateTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatLocalTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildQuickRange(key: string) {
  const now = new Date();
  if (key === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start: start.toISOString(), end: now.toISOString() };
  }
  if (key === "yesterday") {
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
    );
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (key === "week") {
    const weekday = now.getDay() === 0 ? 7 : now.getDay();
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - (weekday - 1),
    );
    return { start: start.toISOString(), end: now.toISOString() };
  }
  const selected = QUICK_RANGES.find((x) => x.key === key && "minutes" in x);
  if (!selected || !("minutes" in selected)) return null;
  const end = now;
  const start = new Date(end.getTime() - selected.minutes * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export default function WpMonitorPage() {
  const formatCount = useCallback((v: number) => fmtCount(v), []);
  const formatRate2 = useCallback((v: number) => `${v.toFixed(2)} e/s`, []);

  const [snapshot, setSnapshot] = useState<LayerSnapshot | null>(null);
  const [startTime, setStartTime] = useState(() => toIsoByMinutesAgo(5));
  const [endTime, setEndTime] = useState(() => new Date().toISOString());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toastVisible, setToastVisible] = useState(false);

  const [selectedNode, setSelectedNode] = useState("");
  const [hoveredNode, setHoveredNode] = useState("");
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [series, setSeries] = useState<NodeTimeSeries | null>(null);
  const [detailStartTime, setDetailStartTime] = useState("");
  const [detailEndTime, setDetailEndTime] = useState("");
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState("");
  const [detailPanelHeight, setDetailPanelHeight] = useState(360);
  const [missLogsLoading, setMissLogsLoading] = useState(false);
  const [missLogsError, setMissLogsError] = useState("");
  const [missLogs, setMissLogs] = useState<VlogRecord[]>([]);
  const [missHasMore, setMissHasMore] = useState(false);
  const [missPage, setMissPage] = useState(1);
  const [missExporting, setMissExporting] = useState(false);
  const [missWindowStart, setMissWindowStart] = useState("");
  const [missWindowEnd, setMissWindowEnd] = useState("");

  const [expandedPackages, setExpandedPackages] = useState<string[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);

  const [draftRange, setDraftRange] = useState("5m");
  const [draftStart, setDraftStart] = useState<Date | null>(() =>
    toDateFromIso(toIsoByMinutesAgo(5)),
  );
  const [draftEnd, setDraftEnd] = useState<Date | null>(() =>
    toDateFromIso(new Date().toISOString()),
  );
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(5);
  const [refreshIntervalInput, setRefreshIntervalInput] = useState("5");
  const [detailTrendAutoRefresh, setDetailTrendAutoRefresh] = useState(true);

  const [parseQuery, setParseQuery] = useState("");
  const [parseSearchOpen, setParseSearchOpen] = useState(false);
  const [parseSearchActiveIndex, setParseSearchActiveIndex] = useState(0);
  const parseSearchRef = useRef<HTMLDivElement | null>(null);
  const detailPanelRef = useRef<HTMLElement | null>(null);
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );

  const clampDetailPanelHeight = useCallback((h: number) => {
    const isMobile = window.innerWidth <= 768;
    const minHeight = isMobile ? Math.floor(window.innerHeight * 0.56) : 220;
    const maxHeight = isMobile
      ? Math.floor(window.innerHeight * 0.9)
      : Math.floor(window.innerHeight * 0.86);
    return Math.min(maxHeight, Math.max(minHeight, h));
  }, []);

  async function loadSnapshot(start = startTime, end = endTime) {
    try {
      setLoading(true);
      setError("");
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
    if (!snapshot) return;
    try {
      const ids = collectAllNodeIds(snapshot);
      // 自动刷新时保持窗口长度恒定，避免仅更新 end_time 导致时间范围持续漂移。
      const nowMs = Date.now();
      const startMs = new Date(startTime).getTime();
      const endMs = new Date(endTime).getTime();
      const durationMs =
        Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
          ? endMs - startMs
          : 5 * 60 * 1000;
      const nextEnd = new Date(nowMs).toISOString();
      const nextStart = new Date(nowMs - durationMs).toISOString();
      const data = await fetchMetrics(nextStart, nextEnd, ids);
      setSnapshot((prev) =>
        prev ? applyMetricsToSnapshot(prev, data.items) : prev,
      );
      setStartTime(nextStart);
      setEndTime(nextEnd);
    } catch {
      await loadSnapshot();
    }
  }

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const timer = setInterval(() => {
      void refreshMetricsOnly();
    }, refreshIntervalSec * 1000);
    return () => clearInterval(timer);
  }, [
    snapshot,
    startTime,
    autoRefreshEnabled,
    refreshIntervalSec,
  ]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (!parseSearchRef.current?.contains(target)) setParseSearchOpen(false);
      if (
        selectedNode &&
        !detailPanelRef.current?.contains(target) &&
        !(target as Element).closest(
          ".node, .package, .group, .log-item, .sink-item, .miss",
        )
      ) {
        setSelectedNode("");
      }
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [selectedNode]);

  useEffect(() => {
    const onResize = () => {
      setDetailPanelHeight((prev) => clampDetailPanelHeight(prev));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampDetailPanelHeight]);

  useEffect(() => {
    if (!error) {
      setToastVisible(false);
      return;
    }
    setToastVisible(true);
    const timer = window.setTimeout(() => {
      setToastVisible(false);
      setError("");
    }, 2800);
    return () => window.clearTimeout(timer);
  }, [error]);

  const nodesCount = useMemo(() => {
    if (!snapshot) return 0;
    const parseLogs = snapshot.parses.reduce(
      (acc, p) => acc + p.logs.length,
      0,
    );
    const sinks = snapshot.sinks.reduce((acc, s) => acc + s.sinks.length, 0);
    return (
      snapshot.sources.length +
      snapshot.parses.length +
      parseLogs +
      snapshot.sinks.length +
      sinks +
      1
    );
  }, [snapshot]);

  const rateChartPoints = useMemo(
    () => series?.log_rate_eps ?? [],
    [series?.log_rate_eps],
  );
  const isMissSelected = useMemo(
    () =>
      Boolean(snapshot && selectedNode && selectedNode === snapshot.miss.id),
    [snapshot, selectedNode],
  );
  const missHasData = useMemo(() => {
    if (!snapshot) return false;
    return (
      snapshot.miss.metrics.log_count > 0 ||
      snapshot.miss.metrics.log_rate_eps > 0
    );
  }, [snapshot]);
  const missPageItems = useMemo(() => missLogs, [missLogs]);

  useEffect(() => {
    if (
      !selectedNode ||
      isMissSelected ||
      !detailTrendAutoRefresh ||
      drawerLoading
    )
      return;
    const startMs = new Date(detailStartTime).getTime();
    const endMs = new Date(detailEndTime).getTime();
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs >= endMs
    )
      return;
    const durationMs = endMs - startMs;
    let cancelled = false;

    const refreshSelectedNodeDetail = async () => {
      try {
        const nextEndMs = Date.now();
        const nextStart = new Date(nextEndMs - durationMs).toISOString();
        const nextEnd = new Date(nextEndMs).toISOString();
        const [detailResp, seriesResp] = await Promise.all([
          fetchNodeDetail(selectedNode, nextStart, nextEnd),
          fetchNodeTimeSeries(selectedNode, nextStart, nextEnd),
        ]);
        if (cancelled) return;
        setDetail(detailResp.data);
        setSeries(seriesResp.data);
        setDetailStartTime(nextStart);
        setDetailEndTime(nextEnd);
        setDrawerError("");
      } catch (e) {
        if (cancelled) return;
        setDrawerError((e as Error).message || "节点详情获取失败");
      }
    };

    const timer = setInterval(() => {
      void refreshSelectedNodeDetail();
    }, refreshIntervalSec * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    selectedNode,
    isMissSelected,
    detailTrendAutoRefresh,
    drawerLoading,
    detailStartTime,
    detailEndTime,
    refreshIntervalSec,
  ]);

  const parseSearchGroups = useMemo(() => {
    if (!snapshot) return [];
    const q = parseQuery.trim().toLowerCase();
    if (!q) return [];
    return snapshot.parses
      .map((p) => {
        const pkgMatched = p.package_name.toLowerCase().includes(q);
        const logsMatched = p.logs.filter((l) =>
          l.name.toLowerCase().includes(q),
        );
        if (!pkgMatched && logsMatched.length === 0) return null;
        return { pkg: p, logsMatched };
      })
      .filter(Boolean) as Array<{
      pkg: LayerSnapshot["parses"][number];
      logsMatched: LayerSnapshot["parses"][number]["logs"];
    }>;
  }, [snapshot, parseQuery]);

  const parseSearchFlatItems = useMemo(() => {
    const list: ParseSearchItem[] = [];
    parseSearchGroups.forEach((g) => {
      list.push({
        key: `pkg:${g.pkg.id}`,
        type: "package",
        packageId: g.pkg.id,
        packageName: g.pkg.package_name,
        label: `${g.pkg.package_name} package ${g.logsMatched.length ? `(${g.logsMatched.length})` : ""}`,
      });
      g.logsMatched.forEach((l) => {
        list.push({
          key: `log:${l.id}`,
          type: "log",
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

  function nodeClass(
    base: string,
    nodeId: string,
    _type: Exclude<LegendType, null>,
  ) {
    const classes = [base];
    if (selectedNode === nodeId) classes.push("selected");
    if (hoveredNode === nodeId) classes.push("active");
    return classes.join(" ");
  }

  async function loadMissedLogs(start: string, end: string, page: number) {
    try {
      setMissLogsLoading(true);
      setMissLogsError("");
      const data = await fetchMissedLogs(start, end, page, MISS_PAGE_SIZE);
      setMissLogs(data.items);
      setMissHasMore(data.has_more);
      setMissPage(data.page);
      return true;
    } catch (e) {
      setMissLogs([]);
      setMissHasMore(false);
      setMissLogsError((e as Error).message || "MISS 日志获取失败");
      return false;
    } finally {
      setMissLogsLoading(false);
    }
  }

  async function onExportMissed() {
    if (!isMissSelected) return;
    try {
      setMissExporting(true);
      const exportStart = missWindowStart || detailStartTime;
      const exportEnd = missWindowEnd || detailEndTime;
      const resp = await exportMissedLogs(exportStart, exportEnd);
      const blob = await resp.blob();
      const contentDisposition = resp.headers.get("content-disposition") || "";
      const matched = contentDisposition.match(/filename="([^"]+)"/i);
      const filename = matched?.[1] || `miss-${Date.now()}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.dispatchEvent(
        new MouseEvent("click", {
          bubbles: false,
          cancelable: true,
          view: window,
        }),
      );
      URL.revokeObjectURL(url);
    } catch (e) {
      setMissLogsError((e as Error).message || "MISS 日志导出失败");
    } finally {
      setMissExporting(false);
    }
  }

  async function onPrevMissPage() {
    if (missPage <= 1) return;
    const pageStart = missWindowStart || detailStartTime;
    const pageEnd = missWindowEnd || detailEndTime;
    await loadMissedLogs(pageStart, pageEnd, missPage - 1);
  }

  async function onNextMissPage() {
    if (!missHasMore) return;
    const pageStart = missWindowStart || detailStartTime;
    const pageEnd = missWindowEnd || detailEndTime;
    await loadMissedLogs(pageStart, pageEnd, missPage + 1);
  }

  async function openDetail(nodeId: string) {
    const missNodeId = snapshot?.miss.id ?? "";
    const isMissNode = nodeId === missNodeId;
    let currentStart = startTime;
    let currentEnd = endTime || new Date().toISOString();
    const startMs = new Date(currentStart).getTime();
    const endMs = new Date(currentEnd).getTime();
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs >= endMs
    ) {
      currentEnd = new Date(Date.now()).toISOString();
      const fallbackStart = new Date(
        new Date(currentEnd).getTime() - 5 * 60 * 1000,
      ).toISOString();
      currentStart = Number.isFinite(startMs) ? currentStart : fallbackStart;
      if (new Date(currentStart).getTime() >= new Date(currentEnd).getTime()) {
        currentStart = fallbackStart;
      }
    }
    setSelectedNode(nodeId);
    setDetailStartTime(currentStart);
    setDetailEndTime(currentEnd);
    setDrawerLoading(true);
    setDrawerError("");
    setDetail(null);
    setSeries(null);
    setMissLogs([]);
    setMissHasMore(false);
    setMissLogsError("");
    setMissLogsLoading(false);
    setMissWindowStart("");
    setMissWindowEnd("");
    try {
      const detailPromise = fetchNodeDetail(nodeId, currentStart, currentEnd);
      const seriesPromise = fetchNodeTimeSeries(
        nodeId,
        currentStart,
        currentEnd,
      );
      if (isMissNode) {
        setMissLogsLoading(true);
        setMissWindowStart(currentStart);
        setMissWindowEnd(currentEnd);
        const [detailResp, seriesResp, missedResp] = await Promise.all([
          detailPromise,
          seriesPromise,
          fetchMissedLogs(currentStart, currentEnd, 1, MISS_PAGE_SIZE),
        ]);
        setMissLogs(missedResp.items);
        setMissHasMore(missedResp.has_more);
        setMissPage(missedResp.page);
        setMissLogsError("");
        setMissLogsLoading(false);
        setDetail(detailResp.data);
        setSeries(seriesResp.data);
        return;
      }
      const [detailResp, seriesResp] = await Promise.all([
        detailPromise,
        seriesPromise,
      ]);
      setDetail(detailResp.data);
      setSeries(seriesResp.data);
    } catch (e) {
      if (isMissNode) {
        setMissLogs([]);
        setMissLogsError((e as Error).message || "MISS 日志获取失败");
        setMissLogsLoading(false);
      }
      setDrawerError((e as Error).message || "节点详情获取失败");
    } finally {
      setDrawerLoading(false);
    }
  }

  function togglePackage(pkgId: string) {
    setExpandedPackages((prev) =>
      prev.includes(pkgId)
        ? prev.filter((id) => id !== pkgId)
        : [...prev, pkgId],
    );
  }

  function toggleGroup(groupId: string) {
    setExpandedGroups((prev) =>
      prev.includes(groupId)
        ? prev.filter((id) => id !== groupId)
        : [...prev, groupId],
    );
  }

  async function applyTimeRange(
    nextStart: string,
    nextEnd: string,
    enableAutoRefresh: boolean,
  ) {
    if (new Date(nextStart).getTime() >= new Date(nextEnd).getTime()) {
      setError("开始时间必须早于结束时间");
      return;
    }
    setError("");
    setStartTime(nextStart);
    setEndTime(nextEnd);
    setAutoRefreshEnabled(enableAutoRefresh);
    await loadSnapshot(nextStart, nextEnd);
  }

  async function onPickRange(key: string) {
    setDraftRange(key);
    const range = buildQuickRange(key);
    if (!range) return;
    setDraftStart(new Date(range.start));
    setDraftEnd(new Date(range.end));
    await applyTimeRange(range.start, range.end, true);
  }

  async function onApplyTime() {
    if (!draftStart || !draftEnd) {
      setError("时间格式无效");
      return;
    }
    const nextStart = draftStart.toISOString();
    const nextEnd = draftEnd.toISOString();
    // 手动点击“查询”视为自定义时间查询，固定关闭自动刷新，避免选定窗口被改写。
    await applyTimeRange(nextStart, nextEnd, false);
  }

  function onRefreshIntervalChange(raw: string) {
    if (raw === "") {
      setRefreshIntervalInput("");
      return;
    }
    if (!/^\d+$/.test(raw)) return;
    setRefreshIntervalInput(raw);
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      setRefreshIntervalSec(Math.max(1, parsed));
    }
  }

  function commitRefreshIntervalInput() {
    const parsed = Number.parseInt(refreshIntervalInput, 10);
    const normalized = Number.isNaN(parsed) ? 1 : Math.max(1, parsed);
    setRefreshIntervalSec(normalized);
    setRefreshIntervalInput(String(normalized));
  }

  function onRefreshIntervalKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    commitRefreshIntervalInput();
    e.currentTarget.blur();
  }

  async function onSelectParsePackage(packageId: string, packageName: string) {
    setExpandedPackages((prev) =>
      prev.includes(packageId) ? prev : [...prev, packageId],
    );
    setParseQuery(packageName);
    setParseSearchOpen(false);
    await openDetail(packageId);
  }

  async function onSelectParseLog(
    packageId: string,
    logId: string,
    packageName: string,
    logName: string,
  ) {
    setExpandedPackages((prev) =>
      prev.includes(packageId) ? prev : [...prev, packageId],
    );
    setParseQuery(`${packageName} / ${logName}`);
    setParseSearchOpen(false);
    await openDetail(logId);
  }

  async function onSelectParseItem(item: ParseSearchItem) {
    if (item.type === "package") {
      await onSelectParsePackage(item.packageId, item.packageName);
      return;
    }
    await onSelectParseLog(
      item.packageId,
      item.logId,
      item.packageName,
      item.logName,
    );
  }

  async function onParseSearchKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
  ) {
    if (!parseSearchOpen || !parseQuery.trim()) return;
    if (parseSearchFlatItems.length === 0) {
      if (e.key === "Escape") {
        setParseSearchOpen(false);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setParseSearchActiveIndex(
        (prev) => (prev + 1) % parseSearchFlatItems.length,
      );
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setParseSearchActiveIndex(
        (prev) =>
          (prev - 1 + parseSearchFlatItems.length) %
          parseSearchFlatItems.length,
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = parseSearchFlatItems[parseSearchActiveIndex];
      if (item) await onSelectParseItem(item);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setParseSearchOpen(false);
    }
  }

  function moveParseSelection(delta: number) {
    if (
      !parseSearchOpen ||
      !parseQuery.trim() ||
      parseSearchFlatItems.length === 0
    )
      return;
    setParseSearchActiveIndex(
      (prev) =>
        (prev + delta + parseSearchFlatItems.length) %
        parseSearchFlatItems.length,
    );
  }

  function onDetailPanelResizeMove(e: PointerEvent) {
    const state = resizeStateRef.current;
    if (!state) return;
    const delta = state.startY - e.clientY;
    setDetailPanelHeight(clampDetailPanelHeight(state.startHeight + delta));
  }

  function onDetailPanelResizeEnd() {
    resizeStateRef.current = null;
    window.removeEventListener("pointermove", onDetailPanelResizeMove);
    window.removeEventListener("pointerup", onDetailPanelResizeEnd);
  }

  function onDetailPanelResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    resizeStateRef.current = {
      startY: e.clientY,
      startHeight: detailPanelHeight,
    };
    window.addEventListener("pointermove", onDetailPanelResizeMove);
    window.addEventListener("pointerup", onDetailPanelResizeEnd);
  }

  return (
    <div
      className="app"
      id="app"
      style={
        selectedNode
          ? { paddingBottom: `${detailPanelHeight + 22}px` }
          : undefined
      }
    >
      <div className="title-wrap">
        <div className="title">WP MONITOR</div>
        <div className="toolbar-right">
          <div className="wd-quick-inline">
            {QUICK_RANGES.map((r) => (
              <button
                key={r.key}
                className={`wd-time-quick-btn ${draftRange === r.key ? "active" : ""} ${["today", "yesterday", "week"].includes(r.key) ? "short" : ""}`}
                type="button"
                onClick={() => void onPickRange(r.key)}
              >
                {r.label}
              </button>
            ))}
            <button
              className={`wd-time-quick-btn short ${draftRange === "custom" ? "active" : ""}`}
              type="button"
              onClick={() => setDraftRange("custom")}
            >
              自定义
            </button>
          </div>
          <div className="wd-chip wd-time-field wd-time-range-field">
            <span className="wd-time-field-label">时间范围</span>
            <ConfigProvider locale={antdZhCN}>
              <RangePicker
                className="wd-ant-range"
                classNames={{ popup: { root: "wd-ant-range-popup" } }}
                style={{ width: "336px", maxWidth: "100%" }}
                value={[
                  draftStart ? dayjs(draftStart) : null,
                  draftEnd ? dayjs(draftEnd) : null,
                ]}
                onChange={(dates: null | [Dayjs | null, Dayjs | null]) => {
                  setDraftRange("custom");
                  setDraftStart(dates?.[0]?.toDate() ?? null);
                  setDraftEnd(dates?.[1]?.toDate() ?? null);
                }}
                onCalendarChange={() => {
                  setDraftRange("custom");
                }}
                onOpenChange={(open) => {
                  if (open) setDraftRange("custom");
                }}
                showTime={{ format: "HH:mm:ss", minuteStep: 1, secondStep: 1 }}
                format="YYYY-MM-DD HH:mm:ss"
                allowClear={false}
                separator="→"
                suffixIcon={null}
                placeholder={["开始时间", "结束时间"]}
              />
            </ConfigProvider>
          </div>
          <button
            className="btn-wow-primary wd-time-btn"
            onClick={() => void onApplyTime()}
            disabled={loading}
          >
            查询
          </button>
        </div>
      </div>
      {toastVisible && error && (
        <div className="error-toast" role="alert" aria-live="assertive">
          <span className="error-toast-icon">!</span>
          <span className="error-toast-text">{error}</span>
          <button
            className="error-toast-close"
            type="button"
            onClick={() => {
              setToastVisible(false);
              setError("");
            }}
          >
            ×
          </button>
        </div>
      )}

      <div className="legend">
        <div className="legend-left">
          <span className="legend-item">
            <span className="symbol">●</span>
            <span>来源节点</span>
          </span>
          <span className="legend-item">
            <span className="symbol">◆</span>
            <span>WPL Package(容器)</span>
          </span>
          <span className="legend-item">
            <span className="symbol">▣</span>
            <span>日志类型</span>
          </span>
          <span className="legend-item">
            <span className="symbol">⬡</span>
            <span>输出分组(容器)</span>
          </span>
          <span className="legend-item">
            <span className="symbol">▢</span>
            <span>输出目标</span>
          </span>
          <span className="legend-item static">
            <span className="symbol">⚠</span>
            <span>MISS</span>
          </span>
        </div>
        <div className="legend-metrics">
          <span className="metric-pill badge">
            CPU:{" "}
            {fmtPercentWithMin(snapshot?.sys_metrics.cpu_usage_pct ?? 0, 2)}%
          </span>
          <span className="metric-pill badge">
            MEM: {snapshot?.sys_metrics.memory_used_mb ?? "0.00"} MB
          </span>
          <span className="metric-pill badge refresh-pill">
            自动刷新:
            <input
              className="refresh-interval-input"
              type="number"
              min={1}
              step={1}
              value={refreshIntervalInput}
              onChange={(e) => onRefreshIntervalChange(e.target.value)}
              onBlur={commitRefreshIntervalInput}
              onKeyDown={onRefreshIntervalKeyDown}
            />
            s
          </span>
        </div>
      </div>

      {loading && <p>加载中...</p>}

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
                    className={nodeClass("node card source", n.id, "source")}
                    onMouseEnter={() => setHoveredNode(n.id)}
                    onMouseLeave={() => setHoveredNode("")}
                    onClick={() => void openDetail(n.id)}
                  >
                    <div className="node-name">● {n.name}</div>
                    <div className="metric">
                      {fmtRate(n.metrics.log_rate_eps)}
                      <br />
                      {fmtCount(n.metrics.log_count)}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="lane">
              <div className="lane-head">
                <div className="lane-title">Parse</div>
                <div className="lane-actions">
                  <button
                    className="mini-btn"
                    onClick={() =>
                      setExpandedPackages(snapshot.parses.map((p) => p.id))
                    }
                  >
                    全部展开
                  </button>
                  <button
                    className="mini-btn"
                    onClick={() => setExpandedPackages([])}
                  >
                    全部收起
                  </button>
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
                    <div
                      className={`parse-search-results ${parseSearchOpen && parseQuery.trim() ? "" : "hidden"}`}
                    >
                      {parseSearchGroups.length === 0 && (
                        <div className="parse-search-item">无匹配结果</div>
                      )}
                      {parseSearchGroups.map((g) => (
                        <div key={g.pkg.id} className="parse-search-group">
                          <div
                            className={`parse-search-item parse-search-group-title ${parseSearchFlatItems[parseSearchActiveIndex]?.key === `pkg:${g.pkg.id}` ? "active" : ""}`}
                            onClick={() =>
                              void onSelectParsePackage(
                                g.pkg.id,
                                g.pkg.package_name,
                              )
                            }
                          >
                            {g.pkg.package_name} package{" "}
                            {g.logsMatched.length
                              ? `(${g.logsMatched.length})`
                              : ""}
                          </div>
                          {g.logsMatched.map((l) => (
                            <div
                              key={l.id}
                              className={`parse-search-item child ${parseSearchFlatItems[parseSearchActiveIndex]?.key === `log:${l.id}` ? "active" : ""}`}
                              onClick={() =>
                                void onSelectParseLog(
                                  g.pkg.id,
                                  l.id,
                                  g.pkg.package_name,
                                  l.name,
                                )
                              }
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
                      className={nodeClass("package card", p.id, "package")}
                      onMouseEnter={() => setHoveredNode(p.id)}
                      onMouseLeave={() => setHoveredNode("")}
                    >
                      <div
                        className="package-head"
                        onClick={() => togglePackage(p.id)}
                      >
                        <div className="package-title">◆ {p.package_name}</div>
                        <div className="package-summary">
                          {fmtRate(p.metrics.log_rate_eps)} /{" "}
                          {fmtCount(p.metrics.log_count)} (汇总) ·{" "}
                          {p.logs.length} 个日志类型 ·{" "}
                          {isExpanded ? "点击收起" : "点击展开"}
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="log-list">
                          {p.logs.map((l) => (
                            <article
                              key={l.id}
                              className={nodeClass(
                                "log-item card",
                                l.id,
                                "log",
                              )}
                              onMouseEnter={() => setHoveredNode(l.id)}
                              onMouseLeave={() => setHoveredNode("")}
                              onClick={() => void openDetail(l.id)}
                            >
                              <div className="item-head">
                                <div className="node-name">▣ {l.name}</div>
                                <div className="metric-inline">
                                  {fmtRate(l.metrics.log_rate_eps)} /{" "}
                                  {fmtCount(l.metrics.log_count)}
                                </div>
                              </div>
                            </article>
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}

                <article
                  className={nodeClass(
                    `node card miss ${missHasData ? "miss-alert" : "miss-muted"}`,
                    snapshot.miss.id,
                    "miss",
                  )}
                  onMouseEnter={() => setHoveredNode(snapshot.miss.id)}
                  onMouseLeave={() => setHoveredNode("")}
                  onClick={() => void openDetail(snapshot.miss.id)}
                >
                  <div className="node-name">⚠ {snapshot.miss.name}</div>
                  <div className="node-sub">未命中任何 WPL 规则</div>
                  <div className="metric">
                    {fmtRate(snapshot.miss.metrics.log_rate_eps)} /{" "}
                    {fmtCount(snapshot.miss.metrics.log_count)}
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
                  <button
                    className="mini-btn"
                    onClick={() =>
                      setExpandedGroups(snapshot.sinks.map((g) => g.id))
                    }
                  >
                    全部展开
                  </button>
                  <button
                    className="mini-btn"
                    onClick={() => setExpandedGroups([])}
                  >
                    全部收起
                  </button>
                </div>
              </div>
              <div className="lane-scroll">
                {snapshot.sinks.map((g) => {
                  const isExpanded = expandedGroups.includes(g.id);
                  return (
                    <section
                      key={g.id}
                      className={nodeClass("group card", g.id, "group")}
                      onMouseEnter={() => setHoveredNode(g.id)}
                      onMouseLeave={() => setHoveredNode("")}
                    >
                      <div onClick={() => toggleGroup(g.id)}>
                        <div className="group-title">⬡ {g.sink_group}</div>
                        <div className="package-summary">
                          {fmtRate(g.metrics.log_rate_eps)} /{" "}
                          {fmtCount(g.metrics.log_count)} · {g.sinks.length}{" "}
                          个输出目标 · {isExpanded ? "点击收起" : "点击展开"}
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="sink-list">
                          {g.sinks.map((s) => (
                            <article
                              key={s.id}
                              className={nodeClass(
                                "sink-item card",
                                s.id,
                                "sink",
                              )}
                              onMouseEnter={() => setHoveredNode(s.id)}
                              onMouseLeave={() => setHoveredNode("")}
                              onClick={() => void openDetail(s.id)}
                            >
                              <div className="item-head">
                                <div className="node-name">▢ {s.sink_name}</div>
                                <div className="metric-inline">
                                  {fmtRate(s.metrics.log_rate_eps)} /{" "}
                                  {fmtCount(s.metrics.log_count)}
                                </div>
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

      <aside
        ref={detailPanelRef}
        className={`detail-panel card ${selectedNode ? "open" : ""}`}
        style={{ height: `${detailPanelHeight}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="detail-resize-bar">
          <div
            className="detail-drag-handle"
            onPointerDown={onDetailPanelResizeStart}
            title="拖拽调整高度"
          />
        </div>
        <div className="detail-panel-head">
          <div className="detail-panel-head-left">
            <div className="detail-panel-title">节点详情</div>
            {detail && <span className="detail-node-pill">{detail.name}</span>}
          </div>
          <div className="detail-panel-head-right">
            <button
              className="drawer-close"
              onClick={() => setSelectedNode("")}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="detail-panel-body">
          {drawerLoading && <p>详情加载中...</p>}
          {!drawerLoading && drawerError && (
            <p className="error">错误: {drawerError}</p>
          )}
          {!drawerLoading && !drawerError && detail && (
            <div className={`detail-grid ${isMissSelected ? "miss-mode" : ""}`}>
              <section className="panel card detail-col">
                <div className="panel-title">基本信息</div>
                <div className="detail-name-type-row">
                  <span
                    className="detail-kv-value detail-name-only"
                    title={detail.name}
                  >
                    {detail.name}
                  </span>
                  <span className="detail-type-badge">{detail.node_type}</span>
                </div>
                <div className="detail-metric-badges">
                  <span className="detail-metric-badge">
                    速率 {fmtRate(detail.metrics.log_rate_eps)}
                  </span>
                  <span className="detail-metric-badge">
                    数量 {fmtCount(detail.metrics.log_count)}
                  </span>
                </div>
                <div className="detail-time-row">
                  <span className="detail-kv-label">时间窗口</span>
                  <span className="detail-kv-value detail-time-value">
                    {formatLocalDateTime(detailStartTime)} -{" "}
                    {formatLocalDateTime(detailEndTime)}
                  </span>
                </div>
              </section>

              {!isMissSelected && (
                <section className="panel card detail-col">
                  <div className="panel-head">
                    <div className="panel-title">速率趋势</div>
                    <button
                      className={`toggle-switch ${detailTrendAutoRefresh ? "on" : ""}`}
                      type="button"
                      role="switch"
                      aria-checked={detailTrendAutoRefresh}
                      aria-label="切换速率趋势实时刷新"
                      onClick={() => setDetailTrendAutoRefresh((prev) => !prev)}
                    >
                      <span className="toggle-switch-label">实时刷新</span>
                      <span className="toggle-switch-track">
                        <span className="toggle-switch-thumb" />
                      </span>
                    </button>
                  </div>
                  <TimeSeriesChart
                    title="速率趋势"
                    points={rateChartPoints}
                    color="#2f6df6"
                    valueFormatter={formatRate2}
                    axisValueFormatter={formatRate2}
                    minY={0}
                    yTickAmount={6}
                    rangeStartLabel={formatLocalTime(detailStartTime)}
                    rangeEndLabel={formatLocalTime(detailEndTime)}
                    showRangeMeta={false}
                  />
                </section>
              )}

              {isMissSelected && (
                <section className="panel card detail-col detail-miss-col">
                  <div className="panel-title">MISS 原始日志</div>
                  <div className="miss-query-toolbar">
                    <button
                      className="mini-btn"
                      type="button"
                      onClick={() =>
                        void loadMissedLogs(
                          missWindowStart || detailStartTime,
                          missWindowEnd || detailEndTime,
                          missPage,
                        )
                      }
                      disabled={missLogsLoading}
                    >
                      刷新本页
                    </button>
                    <button
                      className="mini-btn"
                      type="button"
                      onClick={() => void onExportMissed()}
                      disabled={missExporting}
                    >
                      {missExporting ? "导出中..." : "数据导出"}
                    </button>
                  </div>
                  {missLogsLoading && <p>MISS 日志加载中...</p>}
                  {!missLogsLoading && missLogsError && (
                    <p className="error">错误: {missLogsError}</p>
                  )}
                  {!missLogsLoading &&
                    !missLogsError &&
                    missLogs.length === 0 && <p>当前时间窗口无 MISS 日志</p>}
                  {!missLogsLoading &&
                    !missLogsError &&
                    missLogs.length > 0 && (
                      <>
                        <p className="miss-page-meta">
                          第 {missPage} 页 / 每页 10 条
                          {missHasMore ? "（可继续翻页）" : "（已到末页）"}
                        </p>
                        <div className="miss-scroll">
                          <div className="miss-list">
                            {missPageItems.map((item, idx) => {
                              const offset = (missPage - 1) * MISS_PAGE_SIZE;
                              const rowNo = offset + idx + 1;
                              return (
                                <article
                                  key={`${item.time}-${item.stream_id}-${rowNo}`}
                                  className="miss-record"
                                >
                                  <div className="miss-record-head">
                                    #{rowNo} | {formatLocalDateTime(item.time)}
                                  </div>
                                  <pre className="miss-record-raw">
                                    {item.raw}
                                  </pre>
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
                            disabled={missLogsLoading || !missHasMore}
                            onClick={() => void onNextMissPage()}
                          >
                            下一页
                          </button>
                        </div>
                      </>
                    )}
                </section>
              )}
            </div>
          )}

          {!drawerLoading && !drawerError && !detail && <p>点击节点查看详情</p>}
        </div>
      </aside>
    </div>
  );
}
