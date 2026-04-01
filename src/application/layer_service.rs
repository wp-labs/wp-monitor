use crate::domain::model::{
    LayerSnapshot, LayerVersions, LayersMetricsResponse, MetricsSnapshot, MissNode, NodeDetail,
    NodeMetricsItem, NodeTimeSeries, SnapshotMeta, TimeRangeQuery,
};
use crate::infrastructure::vlog_repository::VlogRepository;
use crate::infrastructure::vm_repository::{VmRepoError, VmRepository};
use crate::shared::config::AppConfig;
use crate::shared::hash::stable_hash_json;
use chrono::Utc;
use std::sync::Arc;

/// 应用服务层：
/// - 负责把基础设施层拿到的原始数据组装成接口响应模型；
/// - 负责少量业务编排（版本号、固定 MISS、节点明细查找等）；
/// - 不直接关心 HTTP/PromQL 细节。
pub struct LayerService {
    vm_repo: Arc<dyn VmRepository>,
    config: AppConfig,
    vlog_repo: Arc<dyn VlogRepository>,
}

impl LayerService {
    /// 通过依赖注入方式接入 VM 仓储抽象，便于后续替换实现/测试。
    pub fn new(vm_repo: Arc<dyn VmRepository>, vlog_repo: Arc<dyn VlogRepository>, config: AppConfig) -> Self {
        Self { vm_repo, vlog_repo, config }
    }

    /// 获取全量分层快照。
    /// 返回内容包括：source/parse/sink/miss/sys_metrics + meta。
    pub async fn get_layers_snapshot(&self, query: TimeRangeQuery) -> Result<LayerSnapshot, VmRepoError> {
        let snapshot_data = self.vm_repo.fetch_snapshot_data(&query).await?;

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

        // 当前版本 MISS 节点按产品要求使用固定值，不从 VM 实时查询。
        Ok(LayerSnapshot {
            meta,
            sources: snapshot_data.sources,
            parses: snapshot_data.parses,
            sinks: snapshot_data.sinks,
            miss: MissNode {
                id: "miss".to_string(),
                name: "MISS".to_string(),
                fixed: true,
                metrics: MetricsSnapshot {
                    log_rate_eps: 15.0,
                    log_count: 13_500,
                    collected_at: Utc::now().to_rfc3339(),
                },
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
        let snapshot = self.get_layers_snapshot(query).await?;

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
                    package_name: Some(node_id.split(':').nth(1).unwrap_or_default().to_string()),
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
            return Ok(NodeDetail {
                id: "miss".to_string(),
                name: "MISS".to_string(),
                node_type: "miss".to_string(),
                package_name: None,
                metrics: MetricsSnapshot {
                    log_rate_eps: 15.0,
                    log_count: 13_500,
                    collected_at: Utc::now().to_rfc3339(),
                },
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
        self.vm_repo.fetch_node_timeseries(node_id, &query, step).await
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
