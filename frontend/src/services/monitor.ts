import type {
  ApiErrorBody,
  ApiResp,
  LayerSnapshot,
  LayersMetricsResponse,
  MissedLogsPage,
  NodeDetail,
  NodeTimeSeries,
  VersionInfo,
  WfPipelineResponse,
  WfSourceItem,
  WfSourceMachineItem,
  WfWindowItem,
  WfRuleItem,
  WfStateMachineItem,
  WfRuleMachineItem,
} from "@/types/monitor";
import { ApiError } from "@/types/monitor";

export type TimeSeriesMetricMode = "rate" | "count";

function normalizeIsoToSecondBoundary(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  date.setMilliseconds(0);
  return date.toISOString();
}

function normalizeTimeRange(startTime: string, endTime: string) {
  return {
    start: normalizeIsoToSecondBoundary(startTime),
    end: normalizeIsoToSecondBoundary(endTime),
  };
}

function normalizeMaxDataPoints(maxDataPoints?: number) {
  if (!maxDataPoints || !Number.isFinite(maxDataPoints)) return undefined;
  return Math.max(60, Math.min(2000, Math.floor(maxDataPoints)));
}

/** 统一请求：成功返回 ApiResp<T>，失败抛出 ApiError（含 code/message/hints） */
async function requestJson<T>(url: string) {
  const resp = await fetch(url);
  if (!resp.ok) {
    const contentType = resp.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const raw = await resp.text().catch(() => '');
    let body: ApiErrorBody | null = null;
    if (isJson && raw) {
      try { body = JSON.parse(raw) as ApiErrorBody; } catch { /* use null */ }
    }
    throw new ApiError(body ?? { status: resp.status, code: String(resp.status), category: 'http', message: raw.slice(0, 200) || `HTTP ${resp.status}`, visibility: 'user', hints: [] });
  }
  const body = await resp.json();
  return body as ApiResp<T>;
}

function isoMinutesAgo(min: number) {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}

function mergeTimePoints(groups: Array<{ ts: string; value: number }[]>) {
  const merged: Array<{ ts: string; value: number }> = [];
  const seen = new Set<string>();
  groups.forEach((points) => {
    points.forEach((point) => {
      if (seen.has(point.ts)) return;
      seen.add(point.ts);
      merged.push(point);
    });
  });
  merged.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return merged;
}

/** 统一 POST 请求：成功返回 ApiResp<T>，失败抛出 ApiError */
async function requestPostJson<T>(url: string, body: unknown) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const contentType = resp.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const raw = await resp.text().catch(() => '');
    let errBody: ApiErrorBody | null = null;
    if (isJson && raw) {
      try { errBody = JSON.parse(raw) as ApiErrorBody; } catch { /* use null */ }
    }
    throw new ApiError(errBody ?? { status: resp.status, code: String(resp.status), category: 'http', message: raw.slice(0, 200) || `HTTP ${resp.status}`, visibility: 'user', hints: [] });
  }
  const json = await resp.json();
  return json as ApiResp<T>;
}

async function requestNodeTimeSeriesOnce(
  nodeId: string,
  startTime: string,
  endTime: string,
  metricMode: TimeSeriesMetricMode,
  maxDataPoints?: number,
) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(
    startTime,
    endTime,
  );
  const safeMaxDataPoints = normalizeMaxDataPoints(maxDataPoints);
  const url = `/api/v1/wp-monitor/nodes/${encodeURIComponent(nodeId)}/timeseries?start_time=${encodeURIComponent(normalizedStart)}&end_time=${encodeURIComponent(normalizedEnd)}&metric_mode=${encodeURIComponent(metricMode)}${safeMaxDataPoints ? `&max_data_points=${safeMaxDataPoints}` : ""}`;
  return requestJson<NodeTimeSeries>(url);
}

export async function fetchParseTimeSeries(
  scope: "parse" | "source" | "sink",
  startTime: string,
  endTime: string,
  metricMode: TimeSeriesMetricMode = "rate",
  maxDataPoints?: number,
  packageName?: string,
  sinkGroup?: string,
  ruleNames?: string[],
) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(
    startTime,
    endTime,
  );
  const safeMaxDataPoints = normalizeMaxDataPoints(maxDataPoints);
  const body: Record<string, unknown> = {
    scope,
    start_time: normalizedStart,
    end_time: normalizedEnd,
    metric_mode: metricMode,
    package_name: packageName ? [packageName] : [],
    rule_name: ruleNames ?? [],
  };
  if (safeMaxDataPoints) body.max_data_points = safeMaxDataPoints;
  if (sinkGroup) body.sink_group = sinkGroup;
  return requestPostJson<NodeTimeSeries[]>("/api/v1/wp-monitor/nodes/timeseries", body);
}

/** 获取 package 级别时序数据 */
export async function fetchPackagesTimeSeries(
  startTime: string,
  endTime: string,
  metricMode: TimeSeriesMetricMode = "rate",
  maxDataPoints?: number,
  filters?: Array<{ packageName: string; ruleNames: string[] }>,
) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(startTime, endTime);
  const safeMaxDataPoints = normalizeMaxDataPoints(maxDataPoints);
  const body: Record<string, unknown> = {
    start_time: normalizedStart,
    end_time: normalizedEnd,
    metric_mode: metricMode,
    filters: (filters ?? []).map((f) => ({
      package_name: f.packageName,
      rule_names: f.ruleNames,
    })),
  };
  if (safeMaxDataPoints) body.max_data_points = safeMaxDataPoints;
  return requestPostJson<NodeTimeSeries[]>("/api/v1/wp-monitor/packages/timeseries", body);
}

export async function fetchSnapshot(startTime?: string, endTime?: string, missSource?: string) {
  const start = normalizeIsoToSecondBoundary(startTime ?? isoMinutesAgo(15));
  const end = normalizeIsoToSecondBoundary(endTime ?? new Date().toISOString());
  let url = `/api/v1/wp-monitor/layers/snapshot?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`;
  if (missSource) {
    url += `&miss_source=${encodeURIComponent(missSource)}`;
  }
  const data = await requestJson<LayerSnapshot>(url);
  return data.data;
}

export async function fetchVersion() {
  const data = await requestJson<VersionInfo>(
    "/api/v1/wp-monitor/meta/version",
  );
  return data.data;
}

export async function fetchMetrics(
  startTime: string,
  endTime: string,
  nodeIds?: string[],
  filters?: Array<{ packageName: string; ruleNames: string[] }>,
) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(
    startTime,
    endTime,
  );
  const body: Record<string, unknown> = {
    start_time: normalizedStart,
    end_time: normalizedEnd,
  };
  if (nodeIds && nodeIds.length > 0) {
    body.node_ids = nodeIds.join(",");
  }
  if (filters && filters.length > 0) {
    body.filters = filters.map((f) => ({
      package_name: f.packageName,
      rule_names: f.ruleNames,
    }));
  }
  const data = await requestPostJson<LayersMetricsResponse>("/api/v1/wp-monitor/layers/metrics", body);
  return data.data;
}

export async function fetchNodeDetail(
  nodeId: string,
  startTime: string,
  endTime: string,
  missSource?: string,
) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(
    startTime,
    endTime,
  );
  let url = `/api/v1/wp-monitor/nodes/${encodeURIComponent(nodeId)}/detail?start_time=${encodeURIComponent(normalizedStart)}&end_time=${encodeURIComponent(normalizedEnd)}`;
  if (missSource) {
    url += `&miss_source=${encodeURIComponent(missSource)}`;
  }
  return requestJson<NodeDetail>(url);
}

export async function fetchNodeTimeSeries(
  nodeId: string,
  startTime: string,
  endTime: string,
  metricMode: TimeSeriesMetricMode = "rate",
  maxDataPoints?: number,
) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(
    startTime,
    endTime,
  );
  const safeMaxDataPoints = normalizeMaxDataPoints(maxDataPoints);
  try {
    return await requestNodeTimeSeriesOnce(
      nodeId,
      normalizedStart,
      normalizedEnd,
      metricMode,
      safeMaxDataPoints,
    );
  } catch (err) {
    const startMs = new Date(normalizedStart).getTime();
    const endMs = new Date(normalizedEnd).getTime();
    const durationMs = endMs - startMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || durationMs <= 0) {
      throw err;
    }
    const fallbackThresholdMs = 24 * 60 * 60 * 1000;
    if (durationMs <= fallbackThresholdMs) {
      throw err;
    }

    const chunkMs = 7 * 24 * 60 * 60 * 1000;
    const chunkCount = Math.max(2, Math.ceil(durationMs / chunkMs));
    const targetPoints = safeMaxDataPoints ?? 720;
    const perChunkPoints = Math.max(
      60,
      Math.min(400, Math.floor(targetPoints / chunkCount)),
    );

    const chunks: NodeTimeSeries[] = [];
    for (let i = 0; i < chunkCount; i += 1) {
      const chunkStartMs = startMs + i * chunkMs;
      const chunkEndMs = Math.min(endMs, startMs + (i + 1) * chunkMs);
      const chunkResp = await requestNodeTimeSeriesOnce(
        nodeId,
        new Date(chunkStartMs).toISOString(),
        new Date(chunkEndMs).toISOString(),
        metricMode,
        perChunkPoints,
      );
      chunks.push(chunkResp.data);
    }

    const merged: NodeTimeSeries = {
      node_id: chunks[0]?.node_id ?? nodeId,
      log_rate_eps: mergeTimePoints(chunks.map((chunk) => chunk.log_rate_eps ?? [])),
      log_count: mergeTimePoints(chunks.map((chunk) => chunk.log_count ?? [])),
    };
    const step = chunks.find((chunk) => typeof chunk.step_secs === "number")?.step_secs;
    if (typeof step === "number") merged.step_secs = step;
    const rateWindow = chunks.find(
      (chunk) => typeof chunk.rate_window_secs === "number",
    )?.rate_window_secs;
    if (typeof rateWindow === "number") merged.rate_window_secs = rateWindow;

    return { code: 0, message: "ok", data: merged };
  }
}

export async function fetchMissedLogs(source?: string) {
  let url = `/api/v1/wp-monitor/vlog/missed?query=${encodeURIComponent("wp_stage:miss")}`;
  if (source) {
    url += `&source=${encodeURIComponent(source)}`;
  }
  const data = await requestJson<MissedLogsPage>(url);
  return data.data;
}

export async function exportMissedLogs(source?: string) {
  let url = `/api/v1/wp-monitor/vlog/missed/export?query=${encodeURIComponent("wp_stage:miss")}`;
  if (source) {
    url += `&source=${encodeURIComponent(source)}`;
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json() as ApiErrorBody;
    throw new ApiError(body);
  }
  return resp;
}

export async function clearMissedLogs(source?: string) {
  let url = `/api/v1/wp-monitor/vlog/missed/clear?query=${encodeURIComponent("wp_stage:miss")}`;
  if (source) {
    url += `&source=${encodeURIComponent(source)}`;
  }
  return requestJson<string>(url);
}

// ── wfusion engine monitoring ──

const WF_BASE = '/api/v1/wp-monitor/wf';

export async function fetchWfPipeline(startTime: string, endTime: string) {
  const { start, end } = normalizeTimeRange(startTime, endTime);
  return requestJson<WfPipelineResponse>(
    `${WF_BASE}/pipeline?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`,
  );
}

export async function fetchWfSources(startTime: string, endTime: string) {
  const { start, end } = normalizeTimeRange(startTime, endTime);
  return requestJson<WfSourceItem[]>(
    `${WF_BASE}/sources?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`,
  );
}

export async function fetchWfSourceMachines(startTime: string, endTime: string) {
  const { start, end } = normalizeTimeRange(startTime, endTime);
  return requestJson<WfSourceMachineItem[]>(
    `${WF_BASE}/sources/machines?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`,
  );
}

export async function fetchWfWindows(startTime: string, endTime: string) {
  const { start, end } = normalizeTimeRange(startTime, endTime);
  return requestJson<WfWindowItem[]>(
    `${WF_BASE}/windows?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`,
  );
}

export async function fetchWfRules(startTime: string, endTime: string) {
  const { start, end } = normalizeTimeRange(startTime, endTime);
  return requestJson<WfRuleItem[]>(
    `${WF_BASE}/rules?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`,
  );
}

export async function fetchWfStateMachines(ruleName: string, startTime: string, endTime: string) {
  const { start, end } = normalizeTimeRange(startTime, endTime);
  return requestJson<WfStateMachineItem[]>(
    `${WF_BASE}/rules/${encodeURIComponent(ruleName)}/state-machines?start_time=${start}&end_time=${end}`,
  );
}

export async function fetchWfRuleMachines(startTime: string, endTime: string) {
  const { start, end } = normalizeTimeRange(startTime, endTime);
  return requestJson<WfRuleMachineItem[]>(
    `${WF_BASE}/rules/machines?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`,
  );
}

export async function fetchWfTimeseriesThroughput(
  startTime: string, endTime: string, groupBy: string, maxDataPoints?: number,
) {
  const { start, end } = normalizeTimeRange(startTime, endTime);
  const dp = maxDataPoints ? `&max_data_points=${maxDataPoints}` : '';
  return requestJson<NodeTimeSeries[]>(
    `${WF_BASE}/timeseries/throughput?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}&group_by=${encodeURIComponent(groupBy)}${dp}`,
  );
}

export async function fetchWfTimeseriesWindows(
  startTime: string, endTime: string, metric: string, maxDataPoints?: number,
) {
  const { start, end } = normalizeTimeRange(startTime, endTime);
  const dp = maxDataPoints ? `&max_data_points=${maxDataPoints}` : '';
  return requestJson<NodeTimeSeries[]>(
    `${WF_BASE}/timeseries/windows?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}&metric=${encodeURIComponent(metric)}${dp}`,
  );
}

export async function fetchWfTimeseriesAlerts(
  startTime: string, endTime: string, groupBy: string, maxDataPoints?: number,
) {
  const { start, end } = normalizeTimeRange(startTime, endTime);
  const dp = maxDataPoints ? `&max_data_points=${maxDataPoints}` : '';
  return requestJson<NodeTimeSeries[]>(
    `${WF_BASE}/timeseries/alerts?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}&group_by=${encodeURIComponent(groupBy)}${dp}`,
  );
}
