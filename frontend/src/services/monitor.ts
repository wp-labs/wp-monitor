import type {
  ApiResp,
  LayerSnapshot,
  LayersMetricsResponse,
  NodeDetail,
  NodeTimeSeries,
  VlogRecord,
} from '../types/monitor';

function isoMinutesAgo(min: number) {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}

export async function fetchSnapshot(startTime?: string, endTime?: string) {
  const start = startTime ?? isoMinutesAgo(15);
  const end = endTime ?? new Date().toISOString();
  const url = `/api/v1/wp-monitor/layers/snapshot?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('snapshot request failed');
  const data = (await resp.json()) as ApiResp<LayerSnapshot>;
  return data.data;
}

export async function fetchMetrics(startTime: string, endTime: string, nodeIds?: string[]) {
  const params = new URLSearchParams({
    start_time: startTime,
    end_time: endTime,
  });
  if (nodeIds && nodeIds.length > 0) {
    params.set('node_ids', nodeIds.join(','));
  }
  const url = `/api/v1/wp-monitor/layers/metrics?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('metrics request failed');
  const data = (await resp.json()) as ApiResp<LayersMetricsResponse>;
  return data.data;
}

export async function fetchNodeDetail(nodeId: string, startTime: string, endTime: string) {
  const url = `/api/v1/wp-monitor/nodes/${encodeURIComponent(nodeId)}/detail?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('detail request failed');
  return (await resp.json()) as ApiResp<NodeDetail>;
}

export async function fetchNodeTimeSeries(
  nodeId: string,
  startTime: string,
  endTime: string,
  step = '30s',
) {
  const url = `/api/v1/wp-monitor/nodes/${encodeURIComponent(nodeId)}/timeseries?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}&step=${encodeURIComponent(step)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('timeseries request failed');
  return (await resp.json()) as ApiResp<NodeTimeSeries>;
}

export async function fetchMissedLogs(startTime: string, endTime: string, limit = 10) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit || 10)));
  const url = `/api/v1/wp-monitor/vlog/missed?query=${encodeURIComponent('wp_stage:miss')}&limit=${safeLimit}&start=${encodeURIComponent(startTime)}&end=${encodeURIComponent(endTime)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('missed logs request failed');
  const data = (await resp.json()) as ApiResp<VlogRecord[]>;
  return data.data;
}
