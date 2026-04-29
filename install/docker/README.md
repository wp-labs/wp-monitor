# warp-observing

这个目录提供了一套观测 wparse 的 Docker Compose 的本地运行环境，用来快速启动以下 3 个服务：

- `victoria-metrics`：指标存储服务，默认暴露 `8428`
- `victoria-logs`：日志存储服务，默认暴露 `9428`
- `wp-monitor`：wparse监控面板，默认端口 `18080`

## 环境变量

```env
RETENTION_PERIOD=15d
VLOG_MAX_DISK_SPACE_USAGE_BYTES=50GiB
```

- `RETENTION_PERIOD`: 指标和日志数据保留时间
- `VLOG_MAX_DISK_SPACE_USAGE_BYTES`: 日志最大磁盘空间使用量，超过后会触发数据清理

`wp-monitor` 镜像版本由仓库内的 [version.txt](/Users/zuowenjian/devspace/wp-labs/developer/wparse/wp-monitor/version.txt:1) 统一管理，
并通过版本同步流程写入 [docker-compose-main.yml](/Users/zuowenjian/devspace/wp-labs/developer/wparse/wp-monitor/install/docker/docker-compose-main.yml:71) 等 compose 文件。

## 安装和启动

```bash
#安装
./setup.sh
#启动 main
./start.sh
#启动 alpha / beta
./start.sh alpha
./start.sh beta
```

## 接入方式
在wparse的`topology/sinks/infra.d/monitor.toml`中添加如下监控配置
```toml
[[sink_group.sinks]]
name = "metrics_vmetrics_sink"
connect = "victoriametrics_sink"
params = { endpoint = "http://127.0.0.1:8428"}
```
在wparse的`topology/sinks/infra.d/miss.toml`中添加如下miss配置
```toml
[[sink_group.sinks]]
name = "victorialogs_output"
connect = "victorialogs_sink"
params = { endpoint = "http://127.0.0.1:9428"}
```
