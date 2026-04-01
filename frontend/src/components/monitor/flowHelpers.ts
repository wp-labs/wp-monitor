import type {
  LayerSnapshot,
  MetricsSnapshot,
  NodeMetricsItem,
} from '../../types/monitor';

export function collectAllNodeIds(snapshot: LayerSnapshot): string[] {
  const ids: string[] = [];
  snapshot.sources.forEach((s) => ids.push(s.id));
  snapshot.parses.forEach((p) => {
    ids.push(p.id);
    p.logs.forEach((l) => ids.push(l.id));
  });
  snapshot.sinks.forEach((g) => {
    ids.push(g.id);
    g.sinks.forEach((s) => ids.push(s.id));
  });
  ids.push(snapshot.miss.id);
  return ids;
}

export function applyMetricsToSnapshot(
  snapshot: LayerSnapshot,
  items: NodeMetricsItem[],
): LayerSnapshot {
  const map = new Map<string, MetricsSnapshot>(
    items.map((i) => [i.node_id, i.metrics]),
  );

  const nextSources = snapshot.sources.map((s) => ({
    ...s,
    metrics: map.get(s.id) ?? s.metrics,
  }));

  const nextParses = snapshot.parses.map((p) => {
    const nextLogs = p.logs.map((l) => ({
      ...l,
      metrics: map.get(l.id) ?? l.metrics,
    }));
    return {
      ...p,
      metrics: map.get(p.id) ?? p.metrics,
      logs: nextLogs,
    };
  });

  const nextSinks = snapshot.sinks.map((g) => {
    const nextLeaves = g.sinks.map((s) => ({
      ...s,
      metrics: map.get(s.id) ?? s.metrics,
    }));
    return {
      ...g,
      metrics: map.get(g.id) ?? g.metrics,
      sinks: nextLeaves,
    };
  });

  return {
    ...snapshot,
    sources: nextSources,
    parses: nextParses,
    sinks: nextSinks,
    miss: {
      ...snapshot.miss,
      metrics: map.get(snapshot.miss.id) ?? snapshot.miss.metrics,
    },
  };
}

export function fmtRate(v: number) {
  return `${v.toFixed(2)} e/s`;
}

export function fmtCount(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return `${v}`;
}
