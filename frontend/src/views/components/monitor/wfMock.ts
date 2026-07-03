import type {
  WfPipelineResponse,
  WfSourceItem,
  WfSourceMachineItem,
  WfWindowItem,
  WfRuleItem,
  WfStateMachineItem,
  WfRuleMachineItem,
  NodeTimeSeries,
} from '@/types/monitor';

const SOURCES: { name: string; type: string; machines: string[] }[] = [
  { name: 'netflow_tcp', type: 'tcp', machines: ['127.0.0.1', '127.0.0.2', '127.0.0.3'] },
  { name: 'auth_source', type: 'file', machines: [] },
  { name: 'conn_source', type: 'file', machines: [] },
];

const WINDOWS = ['conn_events', 'conn_events_tcp', 'auth_events', 'security_alerts'];

const RULES = ['rat_propagation', 'rat_propagation_exploit'];

const MACHINES = ['127.0.0.1', '127.0.0.2', '127.0.0.3'];

const RULE_MACHINES: Record<string, string[]> = {
  rat_propagation: [],
  rat_propagation_exploit: ['127.0.0.1', '127.0.0.2', '127.0.0.3'],
};

const RULE_STATE_MACHINES: Record<string, string[]> = {
  rat_propagation: ['sm_prop_scan', 'sm_prop_beacon', 'sm_prop_c2'],
  rat_propagation_exploit: [
    'sip=10.0.0.50,dip=192.168.1.10',
    'sip=10.0.0.50,dip=192.168.1.11',
    'sip=10.0.0.51,dip=192.168.1.10',
    'sip=10.0.0.51,dip=192.168.1.11',
    'sip=10.0.0.60,dip=192.168.1.20',
    'sip=10.0.0.60,dip=192.168.1.21',
    'sip=10.0.0.61,dip=192.168.1.20',
    'sip=10.0.0.61,dip=192.168.1.21',
  ],
};

const WINDOW_CAPACITIES: Record<string, number> = {
  auth_events: 16 * 1024 * 1024,
  conn_events: 64 * 1024 * 1024,
  conn_events_tcp: 64 * 1024 * 1024,
  security_alerts: 1 * 1024 * 1024,
};

function rng(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── state ──

interface MockState {
  receiverRows: number;
  receiverDelta: number;
  sourceData: Record<string, { rows: number; errors: number; lag: number }>;
  winData: Record<string, { rows: number; mem: number; late: number }>;
  ruleData: Record<string, { emitted: number; instances: number; hitRate: number }>;
  smAlerts: Record<string, number>;
  e2eP99: number;
  dispatchFailed: number;
  history: {
    sourceThroughput: Record<string, number[]>;
    machineThroughput: Record<string, number[]>;
    windowRows: Record<string, number[]>;
    windowMem: Record<string, number[]>;
    windowLate: Record<string, number[]>;
    ruleEmitted: Record<string, number[]>;
    machineAlerts: Record<string, number[]>;
  };
}

const state: MockState = {
  receiverRows: 0,
  receiverDelta: 0,
  sourceData: Object.fromEntries(SOURCES.map((s) => [s.name, { rows: 0, errors: 0, lag: 0 }])),
  winData: Object.fromEntries(
    WINDOWS.map((w) => [w, { rows: 0, mem: 1024, late: 0 }]),
  ),
  ruleData: Object.fromEntries(
    RULES.map((r) => [r, { emitted: 0, instances: 0, hitRate: 0 }]),
  ),
  smAlerts: Object.fromEntries(
    Object.values(RULE_STATE_MACHINES).flat().map((sm) => [sm, 0]),
  ),
  e2eP99: 1.0,
  dispatchFailed: 0,
  history: {
    sourceThroughput: Object.fromEntries(SOURCES.map((s) => [s.name, [] as number[]])),
    machineThroughput: Object.fromEntries(MACHINES.map((m) => [m, [] as number[]])),
    windowRows: Object.fromEntries(WINDOWS.map((w) => [w, [] as number[]])),
    windowMem: Object.fromEntries(WINDOWS.map((w) => [w, [] as number[]])),
    windowLate: Object.fromEntries(WINDOWS.map((w) => [w, [] as number[]])),
    ruleEmitted: Object.fromEntries(RULES.map((r) => [r, [] as number[]])),
    machineAlerts: Object.fromEntries(MACHINES.map((m) => [m, [] as number[]])),
  },
};

function pushHist(arr: number[], v: number, maxLen = 60) {
  arr.push(v);
  while (arr.length > maxLen) arr.shift();
}

export function tickMockState() {
  const s = state;
  s.receiverDelta = rng(200, 2000);
  s.receiverRows += s.receiverDelta;

  // sources
  for (const src of SOURCES) {
    const d = s.sourceData[src.name];
    const delta = rng(30, 500);
    d.rows += delta;
    if (Math.random() < 0.04) d.errors += 1;
    d.lag = Math.max(0, d.lag + rng(-50, 80));
    pushHist(s.history.sourceThroughput[src.name], delta);
  }

  // windows
  for (const w of WINDOWS) {
    const d = s.winData[w];
    d.rows = Math.max(0, d.rows + rng(-20, 80));
    d.mem = Math.max(1024, d.mem + rng(-5, 15) * 1024);
    if (Math.random() < 0.03) d.late += rng(1, 5);
    pushHist(s.history.windowRows[w], d.rows);
    pushHist(s.history.windowMem[w], d.mem);
    pushHist(s.history.windowLate[w], d.late);
  }

  // rules
  for (const r of RULES) {
    const d = s.ruleData[r];
    const sms = RULE_STATE_MACHINES[r] || [];
    const delta = rng(0, 30);
    d.emitted += delta;
    d.instances = sms.length;
    d.hitRate = Math.random() * 40 + 5;
    if (sms.length > 0) {
      const perSM = Math.floor(delta / sms.length);
      let rem = delta % sms.length;
      for (let i = 0; i < sms.length; i++) {
        s.smAlerts[sms[i]] += perSM + (i < rem ? 1 : 0);
      }
    }
    pushHist(s.history.ruleEmitted[r], d.emitted);
  }

  // alert metrics
  s.e2eP99 = Math.random() * 3 + 1;
  if (Math.random() < 0.02) s.dispatchFailed += 1;

  // machine throughput (proportional to source distribution)
  const machineRows: Record<string, number> = {};
  for (const m of MACHINES) machineRows[m] = 0;
  for (const src of SOURCES) {
    const d = s.sourceData[src.name];
    const ms = src.machines;
    if (ms.length > 0) {
      const perM = Math.floor(d.rows / ms.length);
      let rem = d.rows % ms.length;
      for (let i = 0; i < ms.length; i++) {
        machineRows[ms[i]] += perM + (i < rem ? 1 : 0);
      }
    }
  }
  const totalM = Object.values(machineRows).reduce((a, b) => a + b, 0) || 1;
  for (const m of MACHINES) {
    pushHist(s.history.machineThroughput[m], Math.round((machineRows[m] / totalM) * s.receiverDelta));
  }

  // machine alerts
  for (const m of MACHINES) {
    let total = 0;
    for (const r of RULES) {
      const machines = RULE_MACHINES[r] || [];
      if (machines.includes(m)) {
        total += Math.floor(s.ruleData[r].emitted / machines.length);
      }
    }
    pushHist(s.history.machineAlerts[m], total);
  }
}

// ── seed initial data ──
for (let i = 0; i < 30; i++) tickMockState();

// ── API response builders ──

export function buildPipelineResponse(): WfPipelineResponse {
  const totalErrs = SOURCES.reduce((a, s) => a + state.sourceData[s.name].errors, 0);
  const totalRows = WINDOWS.reduce((a, w) => a + state.winData[w].rows, 0);
  const totalMem = WINDOWS.reduce((a, w) => a + state.winData[w].mem, 0);
  const totalLate = WINDOWS.reduce((a, w) => a + state.winData[w].late, 0);
  const totalInst = RULES.reduce((a, r) => a + state.ruleData[r].instances, 0);
  const avgHR = RULES.reduce((a, r) => a + state.ruleData[r].hitRate, 0) / RULES.length;
  const totalEmitted = RULES.reduce((a, r) => a + state.ruleData[r].emitted, 0);

  return {
    generated_at: new Date().toISOString(),
    receiver: {
      total_rows: state.receiverRows,
      rate_rows_per_sec: state.receiverDelta,
      route_errors: totalErrs,
      source_count: SOURCES.length,
    },
    window: {
      window_count: WINDOWS.length,
      total_rows: totalRows,
      total_memory_bytes: totalMem,
      late_dropped: totalLate,
    },
    rule: {
      rule_count: RULES.length,
      total_state_machines: totalInst,
      hit_rate_pct: Math.round(avgHR * 10) / 10,
      total_emitted: totalEmitted,
      send_failed: state.dispatchFailed,
      e2e_p99_ms: Math.round(state.e2eP99 * 1000) / 1000,
    },
  };
}

export function buildSourcesResponse(): WfSourceItem[] {
  return SOURCES.map((src) => ({
    name: src.name,
    type: src.type,
    rows: state.sourceData[src.name].rows,
    route_errors: state.sourceData[src.name].errors,
    consumer_lag: state.sourceData[src.name].lag ?? 0,
    machines: src.machines,
  }));
}

export function buildSourceMachinesResponse(): WfSourceMachineItem[] {
  const map = new Map<string, { rows: number; errors: number; count: number }>();
  for (const m of MACHINES) map.set(m, { rows: 0, errors: 0, count: 0 });
  for (const src of SOURCES) {
    const d = state.sourceData[src.name];
    const ms = src.machines;
    if (ms.length > 0) {
      for (const m of ms) {
        const entry = map.get(m)!;
        entry.count += 1;
        entry.rows += Math.floor(d.rows / ms.length);
        entry.errors += Math.floor(d.errors / ms.length);
      }
    }
  }
  return [...map.entries()]
    .filter(([, v]) => v.count > 0)
    .map(([machine, v]) => ({
      machine,
      rows: v.rows,
      route_errors: v.errors,
      source_count: v.count,
    }));
}

export function buildWindowsResponse(): WfWindowItem[] {
  return WINDOWS.map((w) => ({
    name: w,
    rows: state.winData[w].rows,
    memory_bytes: state.winData[w].mem,
    capacity_bytes: WINDOW_CAPACITIES[w],
    late_dropped: state.winData[w].late,
  }));
}

export function buildRulesResponse(): WfRuleItem[] {
  return RULES.map((r) => ({
    name: r,
    emitted: state.ruleData[r].emitted,
    instances: state.ruleData[r].instances,
  }));
}

export function buildStateMachinesResponse(ruleName: string): WfStateMachineItem[] {
  const sms = RULE_STATE_MACHINES[ruleName] || [];
  return sms
    .map((sm) => ({ scope_key: sm, emitted: state.smAlerts[sm] || 0 }))
    .sort((a, b) => b.emitted - a.emitted);
}

export function buildRuleMachinesResponse(): WfRuleMachineItem[] {
  const map = new Map<string, { emitted: number; count: number }>();
  for (const m of MACHINES) map.set(m, { emitted: 0, count: 0 });
  for (const r of RULES) {
    const ms = RULE_MACHINES[r] || [];
    for (const m of ms) {
      const entry = map.get(m)!;
      entry.count += 1;
      entry.emitted += Math.floor(state.ruleData[r].emitted / ms.length);
    }
  }
  return [...map.entries()]
    .filter(([, v]) => v.count > 0)
    .map(([machine, v]) => ({ machine, emitted: v.emitted, rule_count: v.count }));
}

function buildTimeSeries(
  labels: string[],
  getHist: (label: string) => number[],
): NodeTimeSeries[] {
  const now = new Date();
  const histLen = getHist(labels[0])?.length || 0;
  return labels.map((label) => {
    const data = getHist(label);
    return {
      node_id: label,
      log_rate_eps: data.map((v, i) => ({
        ts: new Date(now.getTime() - (histLen - 1 - i) * 5000).toISOString(),
        value: v,
      })),
      step_secs: 5,
      rate_window_secs: 60,
    };
  });
}

export function buildThroughputTimeseries(groupBy: string): NodeTimeSeries[] {
  if (groupBy === 'machine') {
    return buildTimeSeries(MACHINES, (m) => state.history.machineThroughput[m]);
  }
  return buildTimeSeries(
    SOURCES.map((s) => s.name),
    (s) => state.history.sourceThroughput[s],
  );
}

export function buildWindowsTimeseries(metric: string): NodeTimeSeries[] {
  return buildTimeSeries(WINDOWS, (w) => {
    if (metric === 'memory') return state.history.windowMem[w];
    if (metric === 'late') return state.history.windowLate[w];
    return state.history.windowRows[w];
  });
}

export function buildAlertsTimeseries(groupBy: string): NodeTimeSeries[] {
  if (groupBy === 'machine') {
    return buildTimeSeries(MACHINES, (m) => state.history.machineAlerts[m]);
  }
  return buildTimeSeries(RULES, (r) => state.history.ruleEmitted[r]);
}
