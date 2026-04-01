export interface MetricsSnapshot {
  log_rate_eps: number;
  log_count: number;
  collected_at: string;
}

export interface SourceNode {
  id: string;
  name: string;
  protocol: string;
  metrics: MetricsSnapshot;
}

export interface LogTypeNode {
  id: string;
  name: string;
  metrics: MetricsSnapshot;
}

export interface ParseNode {
  id: string;
  package_name: string;
  metrics: MetricsSnapshot;
  logs: LogTypeNode[];
}

export interface SinkLeafNode {
  id: string;
  sink_group: string;
  sink_name: string;
  metrics: MetricsSnapshot;
}

export interface SinkGroupNode {
  id: string;
  sink_group: string;
  metrics: MetricsSnapshot;
  sinks: SinkLeafNode[];
}

export interface LayerSnapshot {
  meta: {
    generated_at: string;
    layer_versions: {
      source_version: string;
      parse_version: string;
      sink_version: string;
    };
    start_time: string;
    end_time: string;
  };
  sources: SourceNode[];
  parses: ParseNode[];
  sinks: SinkGroupNode[];
  miss: {
    id: string;
    name: string;
    fixed: boolean;
    metrics: MetricsSnapshot;
  };
  sys_metrics: {
    cpu_usage_pct: number;
    memory_used_mb: number;
  };
}

export interface NodeMetricsItem {
  node_id: string;
  metrics: MetricsSnapshot;
}

export interface LayersMetricsResponse {
  generated_at: string;
  items: NodeMetricsItem[];
}

export interface NodeDetail {
  id: string;
  name: string;
  node_type: string;
  package_name: string | null;
  metrics: MetricsSnapshot;
}

export interface TimePoint {
  ts: string;
  value: number;
}

export interface NodeTimeSeries {
  node_id: string;
  log_rate_eps: TimePoint[];
  log_count: TimePoint[];
}

export interface ApiResp<T> {
  code: number;
  message: string;
  data: T;
}
