# wp-monitor Helm Chart

这个目录提供 `wp-monitor` 的 Helm Chart，用于在 Kubernetes 中部署一套最小可用的观测环境，包含以下 3 个服务：

- `victoria-metrics`：指标存储服务，Service 端口 `8428`
- `victoria-logs`：日志存储服务，Service 端口 `9428`
- `wp-monitor`：监控面板，容器端口 `18080`

Chart 路径：`dev-ops/k8s/alpha`

## 默认行为

- `victoria-metrics` 和 `victoria-logs` 默认启用持久化卷
- `wp-monitor` 默认以 `NodePort` 方式暴露
- `wp-monitor` 默认 `nodePort` 为 `30428`
- `wp-monitor` 的配置文件 `app.toml` 由 Helm 自动生成，并指向集群内的 `victoria-metrics` / `victoria-logs` Service
- 当前 Chart 不创建 `ServiceAccount` 和 `HPA`
- `Ingress` 为可选项，仅对 `wp-monitor` 生效

## 前置条件

- Kubernetes 集群可用
- 集群中已经安装 `helm`
- 集群存在可用的默认 `StorageClass`，或你会在 `values.yaml` 中显式指定 `storageClassName`

如果集群没有动态存储供给能力，`victoria-metrics` 和 `victoria-logs` 的 Pod 会因为 PVC 无法绑定而保持 `Pending`。

## 安装

在当前目录执行：

```bash
helm upgrade --install monitor . -n default
```

如果希望安装到独立命名空间：

```bash
helm upgrade --install monitor . -n monitor --create-namespace
```

安装前可以先渲染检查：

```bash
helm lint .
helm template monitor .
```

## 访问 wp-monitor

### NodePort

默认值：

```yaml
wpMonitor:
  service:
    type: NodePort
    port: 18080
    nodePort: 30428
```

获取访问地址：

```bash
export NODE_PORT=$(kubectl get --namespace default -o jsonpath="{.spec.ports[0].nodePort}" services monitor-wp-monitor-wp-monitor)
export NODE_IP=$(kubectl get nodes --namespace default -o jsonpath="{.items[0].status.addresses[0].address}")
echo http://$NODE_IP:$NODE_PORT
```

如果你在 `minikube` 本机环境中，也可以直接访问：

```bash
http://<minikube-node-ip>:30428
```

### Ingress

如果希望通过域名访问，可以打开：

```yaml
wpMonitor:
  ingress:
    enabled: true
    className: nginx
    hosts:
      - host: wp-monitor.local
        paths:
          - path: /
            pathType: Prefix
```

然后重新执行：

```bash
helm upgrade --install monitor . -n default
```

## 关键配置项

### 全局配置

```yaml
global:
  timezone: Asia/Shanghai
  retentionPeriod: 15d
```

- `timezone`：容器时区
- `retentionPeriod`：VictoriaMetrics / VictoriaLogs 的数据保留时间

### victoria-metrics

```yaml
victoriaMetrics:
  image:
    repository: victoriametrics/victoria-metrics
    tag: v1.133.0
  service:
    type: ClusterIP
    port: 8428
  persistence:
    enabled: true
    size: 20Gi
    storageClassName: ""
```

### victoria-logs

```yaml
victoriaLogs:
  image:
    repository: victoriametrics/victoria-logs
    tag: v1.43.0
  service:
    type: ClusterIP
    port: 9428
  persistence:
    enabled: true
    size: 50Gi
    storageClassName: ""
  maxDiskSpaceUsageBytes: 50GiB
```

### wp-monitor

```yaml
wpMonitor:
  replicaCount: 1
  image:
    repository: ghcr.io/wp-labs/wp-monitor
    tag: latest
  service:
    type: NodePort
    port: 18080
    nodePort: 30428
```

## 自定义 values

建议新建覆盖文件，例如 `my-values.yaml`：

```yaml
global:
  retentionPeriod: 7d

victoriaMetrics:
  persistence:
    size: 10Gi

victoriaLogs:
  persistence:
    size: 20Gi
  maxDiskSpaceUsageBytes: 20GiB

wpMonitor:
  service:
    type: NodePort
    nodePort: 30428
```

安装方式：

```bash
helm upgrade --install monitor . -n default -f my-values.yaml
```

## 与 wparse 的接入方式

在 wparse 的 `topology/sinks/infra.d/monitor.toml` 中添加指标 sink：

```toml
[[sink_group.sinks]]
name = "metrics_vmetrics_sink"
connect = "victoriametrics_sink"
params = { endpoint = "http://monitor-wp-monitor-victoria-metrics.default.svc.cluster.local:8428" }
```

在 `topology/sinks/infra.d/miss.toml` 中添加 miss sink：

```toml
[[sink_group.sinks]]
name = "victorialogs_output"
connect = "victorialogs_sink"
params = { endpoint = "http://monitor-wp-monitor-victoria-logs.default.svc.cluster.local:9428" }
```

如果你的 release 名称或 namespace 不是 `monitor/default`，请同步替换服务域名。

## 常见问题

### 1. `helm install ./ monitor` 报错

`helm install` 的参数顺序是：

```bash
helm install <release-name> <chart>
```

当前目录下应执行：

```bash
helm install monitor .
```

### 2. Pod 长时间 `Pending`

优先检查 PVC 和 StorageClass：

```bash
kubectl get pvc -n default
kubectl get storageclass
kubectl describe pod <pod-name> -n default
```

### 3. `wp-monitor` 页面请求 `/layers/snapshot` 返回 500

通常表示 `wp-monitor` 无法访问 `victoria-metrics`，或 `victoria-logs` / `victoria-metrics` 本身没有正常启动。可以先检查：

```bash
kubectl get pods -n default
kubectl logs <wp-monitor-pod> -n default
kubectl logs <victoria-metrics-pod> -n default
kubectl logs <victoria-logs-pod> -n default
```

### 4. `victoria-logs` 因锁文件报错

如果出现类似：

```text
cannot acquire lock on file "/storage/flock.lock"
```

通常说明旧卷状态异常或上一次退出不干净。在 alpha / 本地环境中，最简单的恢复方式通常是重建 `victoria-logs` 的 PVC，但这会丢失该卷中的日志数据。

## 卸载

```bash
helm uninstall monitor -n default
```

如果需要连同 PVC 一起删除，再执行：

```bash
kubectl delete pvc monitor-wp-monitor-victoria-metrics-data -n default
kubectl delete pvc monitor-wp-monitor-victoria-logs-data -n default
```
