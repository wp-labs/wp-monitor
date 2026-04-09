import type {
  ApiResp,
  LayerSnapshot,
  LayersMetricsResponse,
  MissedLogsPage,
  NodeDetail,
  NodeTimeSeries,
} from "../types/monitor";

function isoMinutesAgo(min: number) {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}

export async function fetchSnapshot(startTime?: string, endTime?: string) {
  const start = startTime ?? isoMinutesAgo(15);
  const end = endTime ?? new Date().toISOString();
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
  const params = new URLSearchParams({
    start_time: startTime,
    end_time: endTime,
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
  const url = `/api/v1/wp-monitor/nodes/${encodeURIComponent(nodeId)}/detail?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("detail request failed");
  return (await resp.json()) as ApiResp<NodeDetail>;
}

export async function fetchNodeTimeSeries(
  nodeId: string,
  startTime: string,
  endTime: string,
) {
  const url = `/api/v1/wp-monitor/nodes/${encodeURIComponent(nodeId)}/timeseries?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("timeseries request failed");
  return (await resp.json()) as ApiResp<NodeTimeSeries>;
}

export async function fetchMissedLogs(
  startTime: string,
  endTime: string,
  page = 1,
  pageSize = 10,
) {
  const safePage = Math.max(1, Math.floor(page || 1));
  const safePageSize = Math.max(1, Math.min(100, Math.floor(pageSize || 10)));
  const url = `/api/v1/wp-monitor/vlog/missed?query=${encodeURIComponent("wp_stage:miss")}&start=${encodeURIComponent(startTime)}&end=${encodeURIComponent(endTime)}&page=${safePage}&page_size=${safePageSize}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("missed logs request failed");
  const data = (await resp.json()) as ApiResp<MissedLogsPage>;
  return data.data;
}

export async function exportMissedLogs(startTime: string, endTime: string) {
  const url = `/api/v1/wp-monitor/vlog/missed/export?query=${encodeURIComponent("wp_stage:miss")}&start=${encodeURIComponent(startTime)}&end=${encodeURIComponent(endTime)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("missed logs export failed");
  return resp;
}
