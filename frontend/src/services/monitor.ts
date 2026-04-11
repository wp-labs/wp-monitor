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
  const normalizedStart = normalizeIsoToSecondBoundary(startTime);
  const normalizedEnd = normalizeIsoToSecondBoundary(endTime);
  const safeMaxDataPoints =
    maxDataPoints && Number.isFinite(maxDataPoints)
      ? Math.max(60, Math.min(2000, Math.floor(maxDataPoints)))
      : undefined;
  const url = `/api/v1/wp-monitor/nodes/${encodeURIComponent(nodeId)}/timeseries?start_time=${encodeURIComponent(normalizedStart)}&end_time=${encodeURIComponent(normalizedEnd)}${safeMaxDataPoints ? `&max_data_points=${safeMaxDataPoints}` : ""}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("timeseries request failed");
  return (await resp.json()) as ApiResp<NodeTimeSeries>;
}

export async function fetchSnapshot(startTime?: string, endTime?: string) {
  const start = normalizeIsoToSecondBoundary(startTime ?? isoMinutesAgo(15));
  const end = normalizeIsoToSecondBoundary(endTime ?? new Date().toISOString());
  const url = `/api/v1/wp-monitor/layers/snapshot?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("snapshot request failed");
  const data = (await resp.json()) as ApiResp<LayerSnapshot>;
  return data.data;
}

export async function fetchMetrics(
  startTime: string,
  endTime: string,
  nodeIds?: string[],
) {
  const normalizedStart = normalizeIsoToSecondBoundary(startTime);
  const normalizedEnd = normalizeIsoToSecondBoundary(endTime);
  const params = new URLSearchParams({
    start_time: normalizedStart,
    end_time: normalizedEnd,
  });
  if (nodeIds && nodeIds.length > 0) {
    params.set("node_ids", nodeIds.join(","));
  }
  const url = `/api/v1/wp-monitor/layers/metrics?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("metrics request failed");
  const data = (await resp.json()) as ApiResp<LayersMetricsResponse>;
  return data.data;
}

export async function fetchNodeDetail(
  nodeId: string,
  startTime: string,
  endTime: string,
) {
  const normalizedStart = normalizeIsoToSecondBoundary(startTime);
  const normalizedEnd = normalizeIsoToSecondBoundary(endTime);
  const url = `/api/v1/wp-monitor/nodes/${encodeURIComponent(nodeId)}/detail?start_time=${encodeURIComponent(normalizedStart)}&end_time=${encodeURIComponent(normalizedEnd)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("detail request failed");
  return (await resp.json()) as ApiResp<NodeDetail>;
}

export async function fetchNodeTimeSeries(
  nodeId: string,
  startTime: string,
  endTime: string,
  maxDataPoints?: number,
) {
  const normalizedStart = normalizeIsoToSecondBoundary(startTime);
  const normalizedEnd = normalizeIsoToSecondBoundary(endTime);
  const safeMaxDataPoints =
    maxDataPoints && Number.isFinite(maxDataPoints)
      ? Math.max(60, Math.min(2000, Math.floor(maxDataPoints)))
      : undefined;
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
    const hasPeak = chunks.some(
      (c) => Array.isArray(c.log_rate_peak_eps) && c.log_rate_peak_eps.length > 0,
    );
    if (hasPeak) {
      merged.log_rate_peak_eps = mergeTimePoints(
        chunks.map((c) => c.log_rate_peak_eps ?? []),
      );
    }
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
  const normalizedStart = normalizeIsoToSecondBoundary(startTime);
  const normalizedEnd = normalizeIsoToSecondBoundary(endTime);
  const safePage = Math.max(1, Math.floor(page || 1));
  const safePageSize = Math.max(1, Math.min(100, Math.floor(pageSize || 10)));
  const url = `/api/v1/wp-monitor/vlog/missed?query=${encodeURIComponent("wp_stage:miss")}&start=${encodeURIComponent(normalizedStart)}&end=${encodeURIComponent(normalizedEnd)}&page=${safePage}&page_size=${safePageSize}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("missed logs request failed");
  const data = (await resp.json()) as ApiResp<MissedLogsPage>;
  return data.data;
}

export async function exportMissedLogs(startTime: string, endTime: string) {
  const normalizedStart = normalizeIsoToSecondBoundary(startTime);
  const normalizedEnd = normalizeIsoToSecondBoundary(endTime);
  const url = `/api/v1/wp-monitor/vlog/missed/export?query=${encodeURIComponent("wp_stage:miss")}&start=${encodeURIComponent(normalizedStart)}&end=${encodeURIComponent(normalizedEnd)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("missed logs export failed");
  return resp;
}
