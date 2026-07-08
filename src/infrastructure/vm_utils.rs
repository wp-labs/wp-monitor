use crate::domain::model::TimePoint;
use chrono::Utc;
use std::collections::BTreeMap;

pub(crate) fn ts_to_rfc3339(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| d.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

/// 将 VM 原始点对齐到统一时间网格，空缺位置填入 fill_value。
pub(crate) fn align_points_to_grid(
    start: i64,
    end: i64,
    step_secs: i64,
    points: Vec<TimePoint>,
    fill_value: Option<f64>,
) -> Vec<TimePoint> {
    if start > end || step_secs <= 0 {
        return Vec::new();
    }
    if points.is_empty() {
        return vec![
            TimePoint {
                ts: ts_to_rfc3339(start),
                value: fill_value,
            },
            TimePoint {
                ts: ts_to_rfc3339(end),
                value: fill_value,
            },
        ];
    }
    let point_map = points
        .into_iter()
        .filter_map(|point| {
            let ts = chrono::DateTime::parse_from_rfc3339(&point.ts)
                .ok()?
                .timestamp();
            Some((ts, point))
        })
        .collect::<BTreeMap<_, _>>();
    let Some((&first_real_ts, _)) = point_map.first_key_value() else {
        return Vec::new();
    };
    let start_ts_str = ts_to_rfc3339(start);
    let end_ts_str = ts_to_rfc3339(end);
    let phase_offset = (first_real_ts - start).rem_euclid(step_secs);
    let mut ts = start + phase_offset;
    if ts > first_real_ts {
        ts -= step_secs;
    }
    let mut out = Vec::new();
    while ts <= end {
        if ts >= start {
            if let Some(point) = point_map.get(&ts) {
                out.push(point.clone());
            } else {
                out.push(TimePoint {
                    ts: ts_to_rfc3339(ts),
                    value: fill_value,
                });
            }
        }
        ts += step_secs;
    }
    if out.first().map(|p| p.ts.as_str()) != Some(start_ts_str.as_str()) {
        out.insert(
            0,
            TimePoint {
                ts: start_ts_str,
                value: fill_value,
            },
        );
    }
    if out.last().map(|p| p.ts.as_str()) != Some(end_ts_str.as_str()) {
        out.push(TimePoint {
            ts: end_ts_str,
            value: fill_value,
        });
    }
    out
}
