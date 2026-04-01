use crate::domain::model::{
    LayerSnapshot, LayerVersions, LayersMetricsResponse, MetricsSnapshot, MissNode, NodeDetail,
    NodeMetricsItem, NodeTimeSeries, SnapshotMeta, TimeRangeQuery,
};
use crate::infrastructure::vm_repository::{VmRepoError, VmRepository, VmSnapshotData};
use crate::shared::config::AppConfig;
use crate::shared::hash::stable_hash_json;
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
struct CachedSourceNode {
    id: String,
    name: String,
    protocol: String,
}

#[derive(Debug, Clone)]
struct CachedLogNode {
    id: String,
    name: String,
}

#[derive(Debug, Clone)]
struct CachedParseNode {
    id: String,
    package_name: String,
    logs: Vec<CachedLogNode>,
}

#[derive(Debug, Clone)]
struct CachedSinkLeafNode {
    id: String,
    sink_group: String,
    sink_name: String,
}

#[derive(Debug, Clone)]
struct CachedSinkGroupNode {
    id: String,
    sink_group: String,
    sinks: Vec<CachedSinkLeafNode>,
}

#[derive(Debug, Default)]
struct LayerNodeCache {
    sources: Vec<CachedSourceNode>,
    parses: Vec<CachedParseNode>,
    sinks: Vec<CachedSinkGroupNode>,
}

impl LayerNodeCache {
    fn upsert_from_snapshot(&mut self, data: &VmSnapshotData) {
        for s in &data.sources {
            if self.sources.iter().all(|x| x.id != s.id) {
                self.sources.push(CachedSourceNode {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    protocol: s.protocol.clone(),
                });
            }
        }

        for p in &data.parses {
            if let Some(existing) = self.parses.iter_mut().find(|x| x.id == p.id) {
                if existing.package_name.is_empty() && !p.package_name.is_empty() {
                    existing.package_name = p.package_name.clone();
                }
                for l in &p.logs {
                    if existing.logs.iter().all(|x| x.id != l.id) {
                        existing.logs.push(CachedLogNode {
                            id: l.id.clone(),
                            name: l.name.clone(),
                        });
                    }
                }
            } else {
                self.parses.push(CachedParseNode {
                    id: p.id.clone(),
                    package_name: p.package_name.clone(),
                    logs: p
                        .logs
                        .iter()
                        .map(|l| CachedLogNode {
                            id: l.id.clone(),
                            name: l.name.clone(),
                        })
                        .collect(),
                });
            }
        }

        for g in &data.sinks {
            if let Some(existing) = self.sinks.iter_mut().find(|x| x.id == g.id) {
                if existing.sink_group.is_empty() && !g.sink_group.is_empty() {
                    existing.sink_group = g.sink_group.clone();
                }
                for s in &g.sinks {
                    if existing.sinks.iter().all(|x| x.id != s.id) {
                        existing.sinks.push(CachedSinkLeafNode {
                            id: s.id.clone(),
                            sink_group: s.sink_group.clone(),
                            sink_name: s.sink_name.clone(),
                        });
                    }
                }
            } else {
                self.sinks.push(CachedSinkGroupNode {
                    id: g.id.clone(),
                    sink_group: g.sink_group.clone(),
                    sinks: g
                        .sinks
                        .iter()
                        .map(|s| CachedSinkLeafNode {
                            id: s.id.clone(),
                            sink_group: s.sink_group.clone(),
                            sink_name: s.sink_name.clone(),
                        })
                        .collect(),
                });
            }
        }
    }

    fn merge_snapshot(&self, data: VmSnapshotData) -> VmSnapshotData {
        let collected_at = Utc::now().to_rfc3339();
        let zero_metrics = || MetricsSnapshot {
            log_rate_eps: 0.0,
            log_count: 0,
            collected_at: collected_at.clone(),
        };

        let mut source_map = data
            .sources
            .into_iter()
            .map(|s| (s.id.clone(), s))
            .collect::<HashMap<_, _>>();
        let sources = self
            .sources
            .iter()
            .map(|cached| {
                source_map
                    .remove(&cached.id)
                    .unwrap_or_else(|| crate::domain::model::SourceNode {
                        id: cached.id.clone(),
                        name: cached.name.clone(),
                        protocol: cached.protocol.clone(),
                        metrics: zero_metrics(),
                    })
            })
            .collect::<Vec<_>>();

        let mut parse_map = data
            .parses
            .into_iter()
            .map(|p| (p.id.clone(), p))
            .collect::<HashMap<_, _>>();
        let parses = self
            .parses
            .iter()
            .map(|cached_pkg| {
                if let Some(mut curr_pkg) = parse_map.remove(&cached_pkg.id) {
                    let mut curr_log_map = curr_pkg
                        .logs
                        .into_iter()
                        .map(|l| (l.id.clone(), l))
                        .collect::<HashMap<_, _>>();
                    let logs = cached_pkg
                        .logs
                        .iter()
                        .map(|cached_log| {
                            curr_log_map.remove(&cached_log.id).unwrap_or_else(|| {
                                crate::domain::model::LogTypeNode {
                                    id: cached_log.id.clone(),
                                    name: cached_log.name.clone(),
                                    metrics: zero_metrics(),
                                }
                            })
                        })
                        .collect::<Vec<_>>();
                    curr_pkg.logs = logs;
                    curr_pkg
                } else {
                    crate::domain::model::ParseNode {
                        id: cached_pkg.id.clone(),
                        package_name: cached_pkg.package_name.clone(),
                        metrics: zero_metrics(),
                        logs: cached_pkg
                            .logs
                            .iter()
                            .map(|cached_log| crate::domain::model::LogTypeNode {
                                id: cached_log.id.clone(),
                                name: cached_log.name.clone(),
                                metrics: zero_metrics(),
                            })
                            .collect(),
                    }
                }
            })
            .collect::<Vec<_>>();

        let mut sink_group_map = data
            .sinks
            .into_iter()
            .map(|g| (g.id.clone(), g))
            .collect::<HashMap<_, _>>();
        let sinks = self
            .sinks
            .iter()
            .map(|cached_group| {
                if let Some(mut curr_group) = sink_group_map.remove(&cached_group.id) {
                    let mut curr_sink_map = curr_group
                        .sinks
                        .into_iter()
                        .map(|s| (s.id.clone(), s))
                        .collect::<HashMap<_, _>>();
                    let sink_nodes = cached_group
                        .sinks
                        .iter()
                        .map(|cached_sink| {
                            curr_sink_map.remove(&cached_sink.id).unwrap_or_else(|| {
                                crate::domain::model::SinkLeafNode {
                                    id: cached_sink.id.clone(),
                                    sink_group: cached_sink.sink_group.clone(),
                                    sink_name: cached_sink.sink_name.clone(),
                                    metrics: zero_metrics(),
                                }
                            })
                        })
                        .collect::<Vec<_>>();
                    curr_group.sinks = sink_nodes;
                    curr_group
                } else {
                    crate::domain::model::SinkGroupNode {
                        id: cached_group.id.clone(),
                        sink_group: cached_group.sink_group.clone(),
                        metrics: zero_metrics(),
                        sinks: cached_group
                            .sinks
                            .iter()
                            .map(|cached_sink| crate::domain::model::SinkLeafNode {
                                id: cached_sink.id.clone(),
                                sink_group: cached_sink.sink_group.clone(),
                                sink_name: cached_sink.sink_name.clone(),
                                metrics: zero_metrics(),
                            })
                            .collect(),
                    }
                }
            })
            .collect::<Vec<_>>();

        VmSnapshotData {
            sources,
            parses,
            sinks,
            sys_metrics: data.sys_metrics,
        }
    }
}

/// 应用服务层：
/// - 负责把基础设施层拿到的原始数据组装成接口响应模型；
/// - 负责少量业务编排（版本号、固定 MISS、节点明细查找等）；
/// - 不直接关心 HTTP/PromQL 细节。
pub struct LayerService {
    vm_repo: Arc<dyn VmRepository>,
    config: AppConfig,
    node_cache: RwLock<LayerNodeCache>,
}

impl LayerService {
    /// 通过依赖注入方式接入 VM 仓储抽象，便于后续替换实现/测试。
    pub fn new(vm_repo: Arc<dyn VmRepository>, config: AppConfig) -> Self {
        Self {
            vm_repo,
            config,
            node_cache: RwLock::new(LayerNodeCache::default()),
        }
    }

    async fn merge_snapshot_with_cache(&self, snapshot_data: VmSnapshotData) -> VmSnapshotData {
        let mut cache = self.node_cache.write().await;
        cache.upsert_from_snapshot(&snapshot_data);
        cache.merge_snapshot(snapshot_data)
    }

    /// 获取全量分层快照。
    /// 返回内容包括：source/parse/sink/miss/sys_metrics + meta。
    pub async fn get_layers_snapshot(
        &self,
        query: TimeRangeQuery,
    ) -> Result<LayerSnapshot, VmRepoError> {
        let raw_snapshot = self.vm_repo.fetch_snapshot_data(&query).await?;
        let snapshot_data = self.merge_snapshot_with_cache(raw_snapshot).await;

        // 版本号采用“结构稳定哈希”，用于前端识别层结构是否变化。
        let versions = LayerVersions {
            source_version: stable_hash_json(&snapshot_data.sources),
            parse_version: stable_hash_json(&snapshot_data.parses),
            sink_version: stable_hash_json(&snapshot_data.sinks),
        };

        let meta = SnapshotMeta {
            generated_at: Utc::now().to_rfc3339(),
            layer_versions: versions,
            start_time: query.start_time.to_rfc3339(),
            end_time: query.end_time.to_rfc3339(),
        };

        // MISS 节点指标改为走 VM 实时查询（速率 + 时间窗口累计数量）。
        let miss_metrics = self.vm_repo.fetch_miss_metrics(&query).await?;

        Ok(LayerSnapshot {
            meta,
            sources: snapshot_data.sources,
            parses: snapshot_data.parses,
            sinks: snapshot_data.sinks,
            miss: MissNode {
                id: "miss".to_string(),
                name: "MISS".to_string(),
                fixed: false,
                metrics: miss_metrics,
            },
            sys_metrics: snapshot_data.sys_metrics,
        })
    }

    /// 获取节点指标快照（用于前端高频轮询，仅刷新数值）。
    /// 支持按 node_ids 过滤，减少无关数据传输。
    pub async fn get_layers_metrics(
        &self,
        query: TimeRangeQuery,
        node_ids: Option<Vec<String>>,
    ) -> Result<LayersMetricsResponse, VmRepoError> {
        let snapshot = self.get_layers_snapshot(query).await?;

        let mut items = Vec::new();

        for s in &snapshot.sources {
            items.push(NodeMetricsItem {
                node_id: s.id.clone(),
                metrics: s.metrics.clone(),
            });
        }
        for p in &snapshot.parses {
            items.push(NodeMetricsItem {
                node_id: p.id.clone(),
                metrics: p.metrics.clone(),
            });
            for l in &p.logs {
                items.push(NodeMetricsItem {
                    node_id: l.id.clone(),
                    metrics: l.metrics.clone(),
                });
            }
        }
        for g in &snapshot.sinks {
            items.push(NodeMetricsItem {
                node_id: g.id.clone(),
                metrics: g.metrics.clone(),
            });
            for s in &g.sinks {
                items.push(NodeMetricsItem {
                    node_id: s.id.clone(),
                    metrics: s.metrics.clone(),
                });
            }
        }
        items.push(NodeMetricsItem {
            node_id: snapshot.miss.id.clone(),
            metrics: snapshot.miss.metrics.clone(),
        });

        // 仅返回前端关注的节点。
        if let Some(ids) = node_ids {
            items.retain(|i| ids.iter().any(|id| id == &i.node_id));
        }

        Ok(LayersMetricsResponse {
            generated_at: Utc::now().to_rfc3339(),
            items,
        })
    }

    /// 获取节点详情（source/package/log/sink_group/sink/miss）。
    /// 当前实现策略：先基于同时间窗口取全快照，再在内存中定位节点。
    pub async fn get_node_detail(
        &self,
        node_id: &str,
        query: TimeRangeQuery,
    ) -> Result<NodeDetail, VmRepoError> {
        let snapshot = self.get_layers_snapshot(query.clone()).await?;

        for s in snapshot.sources {
            if s.id == node_id {
                return Ok(NodeDetail {
                    id: s.id,
                    name: s.name,
                    node_type: "source".to_string(),
                    package_name: None,
                    metrics: s.metrics,
                });
            }
        }

        for p in snapshot.parses {
            if p.id == node_id {
                return Ok(NodeDetail {
                    id: p.id,
                    name: p.package_name,
                    node_type: "package".to_string(),
                    package_name: None,
                    metrics: p.metrics,
                });
            }
            for l in p.logs {
                if l.id == node_id {
                    return Ok(NodeDetail {
                        id: l.id,
                        name: l.name,
                        node_type: "log_type".to_string(),
                        package_name: Some(
                            node_id.split(':').nth(1).unwrap_or_default().to_string(),
                        ),
                        metrics: l.metrics,
                    });
                }
            }
        }

        for g in snapshot.sinks {
            if g.id == node_id {
                return Ok(NodeDetail {
                    id: g.id,
                    name: g.sink_group,
                    node_type: "sink_group".to_string(),
                    package_name: None,
                    metrics: g.metrics,
                });
            }
            for s in g.sinks {
                if s.id == node_id {
                    return Ok(NodeDetail {
                        id: s.id,
                        name: s.sink_name,
                        node_type: "sink".to_string(),
                        package_name: None,
                        metrics: s.metrics,
                    });
                }
            }
        }

        if node_id == "miss" {
            let miss_metrics = self.vm_repo.fetch_miss_metrics(&query).await?;
            return Ok(NodeDetail {
                id: "miss".to_string(),
                name: "MISS".to_string(),
                node_type: "miss".to_string(),
                package_name: None,
                metrics: miss_metrics,
            });
        }

        // 未命中任何已知节点时，返回 unknown（不抛错，保证接口稳定）。
        Ok(NodeDetail {
            id: node_id.to_string(),
            name: node_id.to_string(),
            node_type: "unknown".to_string(),
            package_name: None,
            metrics: MetricsSnapshot {
                log_rate_eps: 0.0,
                log_count: 0,
                collected_at: Utc::now().to_rfc3339(),
            },
        })
    }

    /// 获取单节点时间序列。
    /// - MISS 在当前版本返回空序列；
    /// - 其它节点委托给 VM 仓储按 node_id 解析并查询。
    pub async fn get_node_timeseries(
        &self,
        node_id: &str,
        query: TimeRangeQuery,
        step: Option<String>,
    ) -> Result<NodeTimeSeries, VmRepoError> {
        if node_id == "miss" {
            return Ok(NodeTimeSeries {
                node_id: "miss".to_string(),
                log_rate_eps: Vec::new(),
                log_count: Vec::new(),
            });
        }
        self.vm_repo
            .fetch_node_timeseries(node_id, &query, step)
            .await
    }

    /// 返回前端初始化配置（从配置文件读取结果回传）。
    pub async fn get_meta_config(&self) -> serde_json::Value {
        serde_json::json!({
          "refresh_interval_sec": self.config.refresh_interval_sec,
          "default_window_min": self.config.default_window_min,
          "time_presets": self.config.time_presets,
          "api_version": self.config.api_version,
          "vm_base_url": self.config.vm_base_url
        })
    }
}
