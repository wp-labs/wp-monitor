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
  fmtRate,
} from "../../components/monitor/flowHelpers";
import TimeSeriesChart from "../../components/monitor/TimeSeriesChart";
import ScopeTrendPanel from "../../components/monitor/ScopeTrendPanel";
import { MONITOR_SERIES_PALETTE } from "../../components/monitor/chartPalette";
import {
  exportMissedLogs,
  fetchMissedLogs,
  fetchMetrics,
  fetchNodeDetail,
  fetchNodeTimeSeries,
  fetchParseTimeSeries,
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
const REALTIME_END_LAG_MS = 5000;
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
type ScopeSeriesRequest = {
  scope: "parse" | "source" | "sink";
  packageName?: string;
  sinkGroup?: string;
};

function toIsoByMinutesAgo(minutes: number) {
  return new Date(Date.now() - REALTIME_END_LAG_MS - minutes * 60 * 1000).toISOString();
}

function nowWithLagMs() {
  return Date.now() - REALTIME_END_LAG_MS;
}

function nowWithLagIso() {
  return new Date(nowWithLagMs()).toISOString();
}

function estimateMaxDataPoints() {
  if (typeof window === "undefined") return 720;
  const panelWidth = Math.max(360, Math.floor(window.innerWidth * 0.58));
  return Math.max(120, Math.min(1600, panelWidth));
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

function normalizeNodePillText(name: string) {
  if (name === "__source__") return "来源层";
  if (name === "__parse__") return "Parse 层";
  if (name === "__sink__") return "输出层";
  return name;
}

function buildQuickRange(key: string) {
  const now = new Date(nowWithLagMs());
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
  const [endTime, setEndTime] = useState(() => nowWithLagIso());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [toastPhase, setToastPhase] = useState<"enter" | "leave">("enter");

  const [selectedNode, setSelectedNode] = useState("");
  const [hoveredNode, setHoveredNode] = useState("");
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [detailNodePill, setDetailNodePill] = useState("");
  const [detailViewMode, setDetailViewMode] = useState<"node" | "scope">(
    "node",
  );
  const [series, setSeries] = useState<NodeTimeSeries | null>(null);
  const [parseSeriesList, setParseSeriesList] = useState<NodeTimeSeries[] | null>(
    null,
  );
  const [hiddenScopeSeriesNames, setHiddenScopeSeriesNames] = useState<string[]>(
    [],
  );
  const [scopeSeriesRequest, setScopeSeriesRequest] =
    useState<ScopeSeriesRequest | null>(null);
  const [parseSeriesTitle, setParseSeriesTitle] = useState("");
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
    toDateFromIso(nowWithLagIso()),
  );
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(5);
  const [refreshIntervalInput, setRefreshIntervalInput] = useState("5");
  const [refreshSpin, setRefreshSpin] = useState(false);
  const [detailTrendAutoRefresh, setDetailTrendAutoRefresh] = useState(true);

  const [parseQuery, setParseQuery] = useState("");
  const [parseSearchOpen, setParseSearchOpen] = useState(false);
  const [parseSearchActiveIndex, setParseSearchActiveIndex] = useState(0);
  const parseSearchRef = useRef<HTMLDivElement | null>(null);
  const detailPanelRef = useRef<HTMLElement | null>(null);
  const toastAutoCloseTimerRef = useRef<number | null>(null);
  const toastCloseTimerRef = useRef<number | null>(null);
  const refreshSpinTimerRef = useRef<number | null>(null);
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );
  const scopeSeriesColorMapRef = useRef<Map<string, string>>(new Map());
  const scopeSeriesColorCursorRef = useRef(0);

  const clampDetailPanelHeight = useCallback((h: number) => {
    const isMobile = window.innerWidth <= 768;
    const minHeight = isMobile ? Math.floor(window.innerHeight * 0.56) : 220;
    const maxHeight = isMobile
      ? Math.floor(window.innerHeight * 0.9)
      : Math.floor(window.innerHeight * 0.86);
    return Math.min(maxHeight, Math.max(minHeight, h));
  }, []);

  const clearToastTimers = useCallback(() => {
    if (toastAutoCloseTimerRef.current !== null) {
      window.clearTimeout(toastAutoCloseTimerRef.current);
      toastAutoCloseTimerRef.current = null;
    }
    if (toastCloseTimerRef.current !== null) {
      window.clearTimeout(toastCloseTimerRef.current);
      toastCloseTimerRef.current = null;
    }
  }, []);

  const hideToast = useCallback((clearError: boolean) => {
    clearToastTimers();
    setToastPhase("leave");
    toastCloseTimerRef.current = window.setTimeout(() => {
      setToastVisible(false);
      setToastPhase("enter");
      if (clearError) setError("");
    }, 150);
  }, [clearToastTimers]);

  const triggerRefreshSpin = useCallback(() => {
    if (refreshSpinTimerRef.current !== null) {
      window.clearTimeout(refreshSpinTimerRef.current);
    }
    setRefreshSpin(true);
    refreshSpinTimerRef.current = window.setTimeout(() => {
      setRefreshSpin(false);
    }, 300);
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
    triggerRefreshSpin();
    try {
      const ids = collectAllNodeIds(snapshot);
      // 自动刷新时保持窗口长度恒定，避免仅更新 end_time 导致时间范围持续漂移。
      const nowMs = nowWithLagMs();
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
          ".node, .package, .group, .log-item, .sink-item, .miss, .lane-title",
        )
      ) {
        setSelectedNode("");
        setDetailNodePill("");
        setScopeSeriesRequest(null);
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
      if (toastVisible) hideToast(false);
      return;
    }
    clearToastTimers();
    setToastVisible(true);
    setToastPhase("enter");
    toastAutoCloseTimerRef.current = window.setTimeout(() => {
      hideToast(true);
    }, 2800);
    return clearToastTimers;
  }, [clearToastTimers, error, hideToast, toastVisible]);

  useEffect(() => {
    return () => {
      clearToastTimers();
      if (refreshSpinTimerRef.current !== null) {
        window.clearTimeout(refreshSpinTimerRef.current);
      }
    };
  }, [clearToastTimers]);

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
  const parseMultiSeries = useMemo(
    () =>
      (parseSeriesList ?? []).map((s) => ({
        name: s.node_id,
        points: s.log_rate_eps ?? [],
        color: (() => {
          const cached = scopeSeriesColorMapRef.current.get(s.node_id);
          if (cached) return cached;
          const color =
            MONITOR_SERIES_PALETTE[
              scopeSeriesColorCursorRef.current % MONITOR_SERIES_PALETTE.length
            ];
          scopeSeriesColorMapRef.current.set(s.node_id, color);
          scopeSeriesColorCursorRef.current += 1;
          return color;
        })(),
      })),
    [parseSeriesList],
  );
  const visibleParseMultiSeries = useMemo(
    () =>
      parseMultiSeries.filter(
        (line) => !hiddenScopeSeriesNames.includes(line.name),
      ),
    [parseMultiSeries, hiddenScopeSeriesNames],
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
  const detailNodePillType = useMemo(() => {
    if (!selectedNode) return "generic";
    if (snapshot?.miss.id === selectedNode) return "miss";
    if (selectedNode === "__source__") return "source";
    if (selectedNode === "__parse__") return "parse";
    if (selectedNode === "__sink__") return "sink";
    if (detail?.node_type === "source") return "source";
    if (detail?.node_type === "parse") return "parse";
    if (detail?.node_type === "sink") return "sink";
    if (snapshot?.sources.some((n) => n.id === selectedNode)) return "source";
    if (
      snapshot?.parses.some(
        (p) =>
          p.id === selectedNode || p.logs.some((log) => log.id === selectedNode),
      )
    )
      return "parse";
    if (
      snapshot?.sinks.some(
        (g) =>
          g.id === selectedNode || g.sinks.some((sink) => sink.id === selectedNode),
      )
    )
      return "sink";
    return "generic";
  }, [detail?.node_type, selectedNode, snapshot]);

  useEffect(() => {
    if (
      !selectedNode ||
      isMissSelected ||
      Boolean(parseSeriesList) ||
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
        const nextEndMs = nowWithLagMs();
        const nextStart = new Date(nextEndMs - durationMs).toISOString();
        const nextEnd = new Date(nextEndMs).toISOString();
        const [detailResp, seriesResp] = await Promise.all([
          fetchNodeDetail(selectedNode, nextStart, nextEnd),
          fetchNodeTimeSeries(
            selectedNode,
            nextStart,
            nextEnd,
            estimateMaxDataPoints(),
          ),
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
    parseSeriesList,
  ]);

  useEffect(() => {
    if (
      !selectedNode ||
      detailViewMode !== "scope" ||
      !scopeSeriesRequest ||
      parseSeriesList === null ||
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

    const refreshScopeTimeseries = async () => {
      try {
        const nextEndMs = nowWithLagMs();
        const nextStart = new Date(nextEndMs - durationMs).toISOString();
        const nextEnd = new Date(nextEndMs).toISOString();
        const timeseriesResp = await fetchParseTimeSeries(
          scopeSeriesRequest.scope,
          nextStart,
          nextEnd,
          estimateMaxDataPoints(),
          scopeSeriesRequest.packageName,
          scopeSeriesRequest.sinkGroup,
        );
        if (cancelled) return;
        setParseSeriesList(timeseriesResp.data ?? []);
        setDetailStartTime(nextStart);
        setDetailEndTime(nextEnd);
        setDrawerError("");
      } catch (e) {
        if (cancelled) return;
        setDrawerError((e as Error).message || "范围时序获取失败");
      }
    };

    const timer = setInterval(() => {
      void refreshScopeTimeseries();
    }, refreshIntervalSec * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    selectedNode,
    detailViewMode,
    scopeSeriesRequest,
    parseSeriesList,
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

  useEffect(() => {
    setHiddenScopeSeriesNames((prev) =>
      prev.filter((name) => parseMultiSeries.some((line) => line.name === name)),
    );
  }, [parseMultiSeries]);

  const resolveNodePillById = useCallback(
    (nodeId: string) => {
      if (!snapshot) return normalizeNodePillText(nodeId);
      if (snapshot.miss.id === nodeId) {
        return normalizeNodePillText(snapshot.miss.name);
      }
      const sourceNode = snapshot.sources.find((n) => n.id === nodeId);
      if (sourceNode) return normalizeNodePillText(sourceNode.name);
      const parseNode = snapshot.parses.find((p) => p.id === nodeId);
      if (parseNode) return normalizeNodePillText(parseNode.package_name);
      for (const parse of snapshot.parses) {
        const logNode = parse.logs.find((l) => l.id === nodeId);
        if (logNode) return normalizeNodePillText(logNode.name);
      }
      const sinkGroup = snapshot.sinks.find((g) => g.id === nodeId);
      if (sinkGroup) return normalizeNodePillText(sinkGroup.sink_group);
      for (const group of snapshot.sinks) {
        const sinkNode = group.sinks.find((s) => s.id === nodeId);
        if (sinkNode) return normalizeNodePillText(sinkNode.sink_name);
      }
      return normalizeNodePillText(nodeId);
    },
    [snapshot],
  );

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
    setDetailViewMode("node");
    setDetailNodePill(resolveNodePillById(nodeId));
    setHiddenScopeSeriesNames([]);
    setScopeSeriesRequest(null);
    const missNodeId = snapshot?.miss.id ?? "";
    const isMissNode = nodeId === missNodeId;
    let currentStart = startTime;
    let currentEnd = endTime || nowWithLagIso();
    const startMs = new Date(currentStart).getTime();
    const endMs = new Date(currentEnd).getTime();
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs >= endMs
    ) {
      currentEnd = nowWithLagIso();
      const fallbackStart = new Date(
        new Date(currentEnd).getTime() - 5 * 60 * 1000,
      ).toISOString();
      currentStart = Number.isFinite(startMs) ? currentStart : fallbackStart;
      if (new Date(currentStart).getTime() >= new Date(currentEnd).getTime()) {
        currentStart = fallbackStart;
      }
    }
    const detailRange = { start: currentStart, end: currentEnd };
    setSelectedNode(nodeId);
    setDetailStartTime(detailRange.start);
    setDetailEndTime(detailRange.end);
    setDrawerLoading(true);
    setDrawerError("");
    setDetail(null);
    setSeries(null);
    setParseSeriesList(null);
    setParseSeriesTitle("");
    setMissLogs([]);
    setMissHasMore(false);
    setMissLogsError("");
    setMissLogsLoading(false);
    setMissWindowStart("");
    setMissWindowEnd("");
    try {
      const detailPromise = fetchNodeDetail(
        nodeId,
        detailRange.start,
        detailRange.end,
      );
      const seriesPromise = fetchNodeTimeSeries(
        nodeId,
        detailRange.start,
        detailRange.end,
        estimateMaxDataPoints(),
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
        setDetailNodePill(normalizeNodePillText(detailResp.data.name));
        setSeries(seriesResp.data);
        return;
      }
      const [detailResp, seriesResp] = await Promise.all([
        detailPromise,
        seriesPromise,
      ]);
      setDetail(detailResp.data);
      setDetailNodePill(normalizeNodePillText(detailResp.data.name));
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

  async function openParseTimeseries(
    scope: "parse" | "source" | "sink",
    selectedId: string,
    title: string,
    packageName?: string,
    sinkGroup?: string,
  ) {
    setDetailViewMode("scope");
    setDetailNodePill(normalizeNodePillText(title.replace(/ 节点趋势$/, "")));
    setHiddenScopeSeriesNames([]);
    setScopeSeriesRequest({ scope, packageName, sinkGroup });
    let currentStart = startTime;
    let currentEnd = endTime || nowWithLagIso();
    const startMs = new Date(currentStart).getTime();
    const endMs = new Date(currentEnd).getTime();
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs >= endMs
    ) {
      currentEnd = nowWithLagIso();
      const fallbackStart = new Date(
        new Date(currentEnd).getTime() - 5 * 60 * 1000,
      ).toISOString();
      currentStart = Number.isFinite(startMs) ? currentStart : fallbackStart;
      if (new Date(currentStart).getTime() >= new Date(currentEnd).getTime()) {
        currentStart = fallbackStart;
      }
    }
    setSelectedNode(selectedId);
    setDetailStartTime(currentStart);
    setDetailEndTime(currentEnd);
    setDrawerLoading(true);
    setDrawerError("");
    setDetail(null);
    setSeries(null);
    setParseSeriesList(null);
    setParseSeriesTitle(title);
    try {
      const timeseriesResp = await fetchParseTimeSeries(
        scope,
        currentStart,
        currentEnd,
        estimateMaxDataPoints(),
        packageName,
        sinkGroup,
      );
      setParseSeriesList(timeseriesResp.data ?? []);
    } catch (e) {
      setDrawerError((e as Error).message || "Parse 时间序列获取失败");
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
    setParseQuery(packageName);
    setParseSearchOpen(false);
    await openParseTimeseries(
      "parse",
      packageId,
      `Package ${packageName} 节点趋势`,
      packageName,
    );
  }

  async function onSelectParseLog(
    _packageId: string,
    logId: string,
    packageName: string,
    logName: string,
  ) {
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
        <div className="title-head">
          <div className="title-logo-shell" aria-hidden="true">
            <img
              className="title-logo"
              src="/asset/wp-monitor-logo.png"
              alt="WP Monitor logo"
            />
          </div>
          <div className="title-brand">
            <div className="title">Wp Monitor</div>
          </div>
        </div>
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
          <span className="wd-chip wd-refresh-chip">
            <span className="wd-time-field-label">自动刷新</span>
            <span
              className={`refresh-live-dot ${autoRefreshEnabled ? "on" : "off"} ${refreshSpin ? "spin" : ""}`}
              aria-hidden="true"
            />
            <input
              className="refresh-interval-input wd-refresh-input"
              type="number"
              min={1}
              step={1}
              value={refreshIntervalInput}
              onChange={(e) => onRefreshIntervalChange(e.target.value)}
              onBlur={commitRefreshIntervalInput}
              onKeyDown={onRefreshIntervalKeyDown}
            />
            <span className="wd-refresh-unit">s</span>
          </span>
        </div>
      </div>
      {toastVisible && error && (
        <div
          className={`error-toast ${toastPhase === "leave" ? "leave" : "enter"}`}
          role="alert"
          aria-live="assertive"
        >
          <span className="error-toast-icon" aria-hidden="true" />
          <span className="error-toast-text">{error}</span>
          <button
            className="error-toast-close"
            type="button"
            onClick={() => {
              hideToast(true);
            }}
          >
            ×
          </button>
        </div>
      )}

      {loading && !snapshot && (
        <div className="loading-skeleton" aria-hidden="true">
          {[0, 1, 2].map((lane) => (
            <section key={lane} className="skeleton-lane">
              <div className="skeleton-title shimmer" />
              <div className="skeleton-card shimmer" />
              <div className="skeleton-card shimmer" />
              <div className="skeleton-card shimmer" />
            </section>
          ))}
        </div>
      )}

      {snapshot && (
        <div className="canvas" id="canvas">
          <div className="columns">
            <section className="lane">
              <div className="lane-head">
                <div
                  className={`lane-title lane-title-clickable ${selectedNode === "__source__" ? "selected" : ""}`}
                  onClick={() =>
                    void openParseTimeseries(
                      "source",
                      "__source__",
                      "来源层全部节点趋势",
                    )
                  }
                >
                  来源层
                </div>
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
                    <div className="node-name">{n.name}</div>
                    <div className="metric-badges">
                      <span className="metric-badge">速率 {fmtRate(n.metrics.log_rate_eps)}</span>
                      <span className="metric-badge">数量 {fmtCount(n.metrics.log_count)}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="lane">
              <div className="lane-head">
                <div
                  className={`lane-title lane-title-clickable ${selectedNode === "__parse__" ? "selected" : ""}`}
                  onClick={() =>
                    void openParseTimeseries(
                      "parse",
                      "__parse__",
                      "Parse 层全部节点趋势",
                    )
                  }
                >
                  Parse
                </div>
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
                  const handlePackageClick = () => {
                    void openParseTimeseries(
                      "parse",
                      p.id,
                      `Package ${p.package_name} 节点趋势`,
                      p.package_name,
                    );
                  };
                  return (
                    <section
                      key={p.id}
                      className={nodeClass("package card", p.id, "package")}
                      onMouseEnter={() => setHoveredNode(p.id)}
                      onMouseLeave={() => setHoveredNode("")}
                      onClick={handlePackageClick}
                    >
                      <div className="package-head">
                        <div className="package-head-main">
                          <div className="package-title package-title-clickable">
                            {p.package_name}
                          </div>
                          <div className="package-summary">
                            {fmtRate(p.metrics.log_rate_eps)} /{" "}
                            {fmtCount(p.metrics.log_count)} (汇总) ·{" "}
                            {p.logs.length} 个日志类型 ·{" "}
                            <button
                              type="button"
                              className="package-summary-toggle"
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePackage(p.id);
                              }}
                            >
                              {isExpanded ? "点击收起" : "点击展开"}
                            </button>
                          </div>
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
                              onClick={(e) => {
                                e.stopPropagation();
                                void openDetail(l.id);
                              }}
                            >
                              <div className="item-head">
                                <div className="node-name">{l.name}</div>
                                <div className="metric-inline-badges">
                                  <span className="metric-inline-badge">
                                    速率 {fmtRate(l.metrics.log_rate_eps)}
                                  </span>
                                  <span className="metric-inline-badge">
                                    数量 {fmtCount(l.metrics.log_count)}
                                  </span>
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
                  <div className="node-name">{snapshot.miss.name}</div>
                  <div className="node-sub">未命中任何 WPL 规则</div>
                  <div className="metric-badges">
                    <span className="metric-badge">速率 {fmtRate(snapshot.miss.metrics.log_rate_eps)}</span>
                    <span className="metric-badge">数量 {fmtCount(snapshot.miss.metrics.log_count)}</span>
                  </div>
                  <div className="node-sub">(不流向任何输出)</div>
                </article>
              </div>
            </section>

            <section className="lane">
              <div className="lane-head">
                <div
                  className={`lane-title lane-title-clickable ${selectedNode === "__sink__" ? "selected" : ""}`}
                  onClick={() =>
                    void openParseTimeseries(
                      "sink",
                      "__sink__",
                      "输出层全部节点趋势",
                    )
                  }
                >
                  输出层 
                </div>
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
                  const handleGroupClick = () => {
                    void openParseTimeseries(
                      "sink",
                      g.id,
                      `Sink Group ${g.sink_group} 节点趋势`,
                      undefined,
                      g.sink_group,
                    );
                  };
                  return (
                    <section
                      key={g.id}
                      className={nodeClass("group card", g.id, "group")}
                      onMouseEnter={() => setHoveredNode(g.id)}
                      onMouseLeave={() => setHoveredNode("")}
                      onClick={handleGroupClick}
                    >
                      <div>
                        <div className="group-title group-title-clickable">
                          {g.sink_group}
                        </div>
                        <div className="package-summary">
                          {fmtRate(g.metrics.log_rate_eps)} /{" "}
                          {fmtCount(g.metrics.log_count)} · {g.sinks.length}{" "}
                          个输出目标 ·{" "}
                          <button
                            type="button"
                            className="package-summary-toggle"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleGroup(g.id);
                            }}
                          >
                            {isExpanded ? "点击收起" : "点击展开"}
                          </button>
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
                                <div className="node-name">{s.sink_name}</div>
                                <div className="metric-inline-badges">
                                  <span className="metric-inline-badge">
                                    速率 {fmtRate(s.metrics.log_rate_eps)}
                                  </span>
                                  <span className="metric-inline-badge">
                                    数量 {fmtCount(s.metrics.log_count)}
                                  </span>
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
            {detailNodePill && (
              <span className={`detail-node-pill detail-node-pill--${detailNodePillType}`}>
                {detailNodePill}
              </span>
            )}
          </div>
          <div className="detail-panel-head-right">
            <button
              className="drawer-close"
              onClick={() => {
                setSelectedNode("");
                setParseSeriesList(null);
                setParseSeriesTitle("");
                setDetailNodePill("");
                setHiddenScopeSeriesNames([]);
                setScopeSeriesRequest(null);
                setDetailViewMode("node");
              }}
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
          {!drawerLoading &&
            !drawerError &&
            detailViewMode === "scope" &&
            parseSeriesList && (
              <ScopeTrendPanel
                title={parseSeriesTitle}
                parseSeriesList={parseSeriesList}
                parseMultiSeries={parseMultiSeries}
                visibleParseMultiSeries={visibleParseMultiSeries}
                hiddenScopeSeriesNames={hiddenScopeSeriesNames}
                detailTrendAutoRefresh={detailTrendAutoRefresh}
                detailStartTime={detailStartTime}
                detailEndTime={detailEndTime}
                onToggleAutoRefresh={() =>
                  setDetailTrendAutoRefresh((prev) => !prev)
                }
                onShowAll={() => setHiddenScopeSeriesNames([])}
                onToggleSeries={(name) =>
                  setHiddenScopeSeriesNames((prev) =>
                    prev.includes(name)
                      ? prev.filter((x) => x !== name)
                      : [...prev, name],
                  )
                }
                formatRate2={formatRate2}
                formatLocalTime={formatLocalTime}
              />
            )}
          {!drawerLoading &&
            !drawerError &&
            detailViewMode === "node" &&
            detail && (
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
                    <div className="panel-head-main">
                      <div className="panel-title">速率趋势</div>
                      <span className="detail-kv-value detail-time-value detail-param-list">
                        <span className="detail-param-item">
                          <span className="detail-param-name">采样间隔</span>
                          <span className="detail-param-data">
                            {series?.step_secs ?? 0}s
                          </span>
                        </span>
                        <span className="detail-param-item">
                          <span className="detail-param-name">统计窗口</span>
                          <span className="detail-param-data">
                            {series?.rate_window_secs ?? 0}s
                          </span>
                        </span>
                      </span>
                    </div>
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
                    showTitleValue={false}
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

          {!drawerLoading &&
            !drawerError &&
            !detail &&
            detailViewMode === "node" &&
            (!parseSeriesList || parseSeriesList.length === 0) && (
              <p>点击节点查看详情</p>
            )}
          {!drawerLoading &&
            !drawerError &&
            detailViewMode === "scope" &&
            parseSeriesList === null && <p>请选择范围以查看时序</p>}
        </div>
      </aside>
    </div>
  );
}
