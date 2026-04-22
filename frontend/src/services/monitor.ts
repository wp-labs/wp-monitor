import type {
  ApiResp,
  LayerSnapshot,
  LayersMetricsResponse,
  MissedLogsPage,
  NodeDetail,
  NodeTimeSeries,
} from "../types/monitor";

function normalizeIsoToSecondBoundary(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setMilliseconds(0);
  return d.toISOString();
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

async function requestJson<T>(url: string, errorMessage: string) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(errorMessage);
  return (await resp.json()) as ApiResp<T>;
}

function isoMinutesAgo(min: number) {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}

function mergeTimePoints(groups: Array<{ ts: string; value: number }[]>) {
  const merged: Array<{ ts: string; value: number }> = [];
  const seen = new Set<string>();
  groups.forEach((points) => {
    points.forEach((p) => {
      if (seen.has(p.ts)) return;
      seen.add(p.ts);
      merged.push(p);
    });
  });
  merged.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return merged;
}

async function requestNodeTimeSeriesOnce(
  nodeId: string,
  startTime: string,
  endTime: string,
  maxDataPoints?: number,
) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(
    startTime,
    endTime,
  );
  const safeMaxDataPoints = normalizeMaxDataPoints(maxDataPoints);
  const url = `/api/v1/wp-monitor/nodes/${encodeURIComponent(nodeId)}/timeseries?start_time=${encodeURIComponent(normalizedStart)}&end_time=${encodeURIComponent(normalizedEnd)}${safeMaxDataPoints ? `&max_data_points=${safeMaxDataPoints}` : ""}`;
  return requestJson<NodeTimeSeries>(url, "timeseries request failed");
}

export async function fetchParseTimeSeries(
  scope: "parse" | "source" | "sink",
  startTime: string,
  endTime: string,
  maxDataPoints?: number,
  packageName?: string,
  sinkGroup?: string,
) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(
    startTime,
    endTime,
  );
  const safeMaxDataPoints = normalizeMaxDataPoints(maxDataPoints);
  const params = new URLSearchParams({
    scope,
    start_time: normalizedStart,
    end_time: normalizedEnd,
  });
  if (safeMaxDataPoints) {
    params.set("max_data_points", String(safeMaxDataPoints));
  }
  if (packageName) {
    params.set("package_name", packageName);
  }
  if (sinkGroup) {
    params.set("sink_group", sinkGroup);
  }
  const url = `/api/v1/wp-monitor/nodes/timeseries?${params.toString()}`;
  return requestJson<NodeTimeSeries[]>(url, "parse timeseries request failed");
}

export async function fetchSnapshot(startTime?: string, endTime?: string) {
  const start = normalizeIsoToSecondBoundary(startTime ?? isoMinutesAgo(15));
  const end = normalizeIsoToSecondBoundary(endTime ?? new Date().toISOString());
  const url = `/api/v1/wp-monitor/layers/snapshot?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`;
  const data = await requestJson<LayerSnapshot>(url, "snapshot request failed");
  return data.data;
}

export async function fetchMetrics(
  startTime: string,
  endTime: string,
  nodeIds?: string[],
) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(
    startTime,
    endTime,
  );
  const params = new URLSearchParams({
    start_time: normalizedStart,
    end_time: normalizedEnd,
  });
  if (nodeIds && nodeIds.length > 0) {
    params.set("node_ids", nodeIds.join(","));
  }
  const url = `/api/v1/wp-monitor/layers/metrics?${params.toString()}`;
  const data = await requestJson<LayersMetricsResponse>(
    url,
    "metrics request failed",
  );
  return data.data;
}

export async function fetchNodeDetail(
  nodeId: string,
  startTime: string,
  endTime: string,
) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(
    startTime,
    endTime,
  );
  const url = `/api/v1/wp-monitor/nodes/${encodeURIComponent(nodeId)}/detail?start_time=${encodeURIComponent(normalizedStart)}&end_time=${encodeURIComponent(normalizedEnd)}`;
  return requestJson<NodeDetail>(url, "detail request failed");
}

export async function fetchNodeTimeSeries(
  nodeId: string,
  startTime: string,
  endTime: string,
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
      safeMaxDataPoints,
    );
  } catch (e) {
    const startMs = new Date(normalizedStart).getTime();
    const endMs = new Date(normalizedEnd).getTime();
    const durationMs = endMs - startMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || durationMs <= 0) {
      throw e;
    }
    // 仅在大窗口失败时回退为分段请求，尽量保持原有性能与行为。
    const fallbackThresholdMs = 24 * 60 * 60 * 1000;
    if (durationMs <= fallbackThresholdMs) {
      throw e;
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
        perChunkPoints,
      );
      chunks.push(chunkResp.data);
    }

    const merged: NodeTimeSeries = {
      node_id: chunks[0]?.node_id ?? nodeId,
      log_rate_eps: mergeTimePoints(chunks.map((c) => c.log_rate_eps ?? [])),
      log_count: mergeTimePoints(chunks.map((c) => c.log_count ?? [])),
    };
    const step = chunks.find((c) => typeof c.step_secs === "number")?.step_secs;
    if (typeof step === "number") merged.step_secs = step;
    const rateWindow = chunks.find(
      (c) => typeof c.rate_window_secs === "number",
    )?.rate_window_secs;
    if (typeof rateWindow === "number") merged.rate_window_secs = rateWindow;

    return { code: 0, message: "ok", data: merged };
  }
}

export async function fetchMissedLogs(
  startTime: string,
  endTime: string,
  page = 1,
  pageSize = 10,
) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(
    startTime,
    endTime,
  );
  const safePage = Math.max(1, Math.floor(page || 1));
  const safePageSize = Math.max(1, Math.min(100, Math.floor(pageSize || 10)));
  const url = `/api/v1/wp-monitor/vlog/missed?query=${encodeURIComponent("wp_stage:miss")}&start=${encodeURIComponent(normalizedStart)}&end=${encodeURIComponent(normalizedEnd)}&page=${safePage}&page_size=${safePageSize}`;
  const data = await requestJson<MissedLogsPage>(
    url,
    "missed logs request failed",
  );
  return data.data;
}

export async function exportMissedLogs(startTime: string, endTime: string) {
  const { start: normalizedStart, end: normalizedEnd } = normalizeTimeRange(
    startTime,
    endTime,
  );
  const url = `/api/v1/wp-monitor/vlog/missed/export?query=${encodeURIComponent("wp_stage:miss")}&start=${encodeURIComponent(normalizedStart)}&end=${encodeURIComponent(normalizedEnd)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("missed logs export failed");
  return resp;
}
