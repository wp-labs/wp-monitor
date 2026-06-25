# Miss数据查询重构

## 需求背景

- 用户会配置miss数据保存的文件路径，我们只需要进行读取即可
- miss数据的文件可能会有很大
- 在我们查询miss时，这个文件可能会随时插入新的数据，但是我们暂时不需要关注这些新插入的数据
- 对于从文件读取的模式，我们只需要查询到当前最新的数据即可，数据的条数由前端进行传递
- 使用文件读取的形式的话，分页查询模式就不太实用了
- miss文件中的数据都是通过空白行进行分割的
- 当用户vlog和miss文件路径都配置时优先使用文件路径，当文件不存在时才使用vlog的路径

## DDD 改造成果

### 改造前问题

| 问题 | 位置 |
|---|---|
| `VmRepository` / `VlogRepository` trait 定义在 infrastructure 层 | `infrastructure/vm_repository.rs` / `vlog_repository.rs` |
| `VlogInstantQuery` 定义在 interfaces 层，被 infrastructure 反向依赖 | `interfaces/vlog/handlers.rs` |
| `PackageFilter` 定义在 interfaces 层，被 application 和 infrastructure 依赖 | `interfaces/vm/handlers.rs` |
| `escape_regex_chars` 定义在 application 层，被 infrastructure 反向依赖 | `application/layer_service.rs` |
| Handler 直接依赖具体类型 `VlogHttpRepository` | `interfaces/vlog/handlers.rs` |
| 缺少 Miss 查询的应用服务和领域 trait | 不存在 |

### 改造后的分层结构

```
src/
├── main.rs                          # 组合根
├── domain/                           # 领域层
│   ├── model.rs                      # 领域实体
│   ├── vm_repository.rs              # VmRepository trait + VmSnapshotData + PackageFilter
│   ├── vlog_repository.rs            # VlogRepository trait + VlogRecord + VlogInstantQuery
│   └── miss_repository.rs            # MissRepository trait + MissRecord + MissQuery
├── application/                      # 应用层
│   ├── layer_service.rs              # LayerService（VM 快照/时序编排）
│   └── miss_service.rs               # MissService（Miss 数据查询编排）
├── infrastructure/                   # 基础设施层
│   ├── vm_repository.rs              # VmHttpRepository（实现 VmRepository）
│   ├── vlog_repository.rs            # VlogHttpRepository（实现 VlogRepository）
│   ├── file_repository.rs            # FileRepository（mmap 文件读取引擎）
│   └── miss_repository_impl.rs       # FileMissRepository / VlogMissRepository
├── interfaces/                       # 接口层
│   ├── vm/handlers.rs                # VM HTTP 处理器（依赖 LayerService）
│   └── vlog/handlers.rs              # Miss HTTP 处理器（依赖 MissService）
└── shared/                           # 共享层
    ├── api.rs, config.rs, error.rs, hash.rs, logging.rs
    └── escape.rs                     # escape_regex_chars 工具函数
```

### 依赖方向

```
interfaces ──→ application ──→ domain ←── infrastructure
                                   ↑
                        shared ────┘
```

- interfaces 只依赖 application + domain
- application 只依赖 domain（trait + model）
- infrastructure 实现 domain trait
- domain 不依赖任何外层
- shared 被所有层依赖

### 具体改动清单

| 操作 | 文件 | 说明 |
|---|---|---|
| 新增 | `src/domain/vm_repository.rs` | VmRepository trait + VmSnapshotData + PackageFilter（从 infra/interfaces 移入） |
| 新增 | `src/domain/vlog_repository.rs` | VlogRepository trait + VlogRecord + VlogInstantQuery（从 infra/interfaces 移入） |
| 新增 | `src/domain/miss_repository.rs` | MissRepository trait + MissRecord + MissQuery（领域端口） |
| 新增 | `src/application/miss_service.rs` | MissService 应用服务 + MissSource 枚举 |
| 新增 | `src/infrastructure/miss_repository_impl.rs` | FileMissRepository / VlogMissRepository（两个适配器） |
| 新增 | `src/shared/escape.rs` | escape_regex_chars 工具函数（从 application 移入） |
| 修改 | `src/domain/mod.rs` | 注册新模块：vm_repository, vlog_repository, miss_repository |
| 修改 | `src/application/mod.rs` | 注册 miss_service |
| 修改 | `src/application/layer_service.rs` | 修复导入：VmRepository/PackageFilter 从 domain 导入，escape_regex_chars 从 shared 导入，移除本地定义 |
| 修改 | `src/infrastructure/mod.rs` | 注册 miss_repository_impl |
| 修改 | `src/infrastructure/vm_repository.rs` | 移除 trait/VmSnapshotData/PackageFilter 定义，改为从 domain 导入；escape_regex_chars 改为从 shared 导入 |
| 修改 | `src/infrastructure/vlog_repository.rs` | 移除 trait/VlogRecord/VlogInstantQuery 定义，改为从 domain 导入；VlogHttpRepository 添加 Clone derive，instant_query 改为 pub |
| 修改 | `src/infrastructure/file_repository.rs` | 无改动（底层引擎保持原样） |
| 修改 | `src/interfaces/vm/handlers.rs` | 移除 PackageFilter 定义，改为从 domain 导入 |
| 修改 | `src/interfaces/vlog/handlers.rs` | Handler 依赖 MissService 替代 VlogHttpRepository；根据 MissSource 分支返回不同 API 响应；移除 VlogInstantQuery 本地定义 |
| 修改 | `src/shared/mod.rs` | 注册 escape 模块 |
| 修改 | `src/main.rs` | 重写为组合根：创建基础设施实现 → 选择 Miss 后端（文件优先，vlog 回退）→ 组装应用服务 → 注入 Actix |

### API 响应设计

文件模式：
```json
{ "code": 0, "data": { "source": "file", "items": [{"content":"..."}] } }
```

Vlog 模式（与现有一致）：
```json
{ "code": 0, "data": { "start":"...", "end":"...", "query":"...", "page":1, "page_size":10, "has_more":true, "items":[{"content":"..."}] } }
```

### 组合根逻辑（main.rs）

```
miss_file_path 已配置且文件存在 → FileMissRepository (MissSource::File)
             ↓ 文件不存在 → VlogMissRepository (MissSource::Vlog)
             ↓ 未配置     → VlogMissRepository (MissSource::Vlog)
```

### 关键设计决策

1. **trait 放 domain 层** — `VmRepository`、`VlogRepository`、`MissRepository` 三个 trait 均定义在 `src/domain/`，作为领域端口
2. **handler 依赖抽象** — `interfaces/vlog/handlers.rs` 不再 import `infrastructure::`，只依赖 `MissService`（应用服务）
3. **组合根决策** — 文件存在性检查在 `main.rs` 启动时一次性完成，不在每次请求时重复判断
4. **spawn_blocking** — 文件读取（mmap）是同步的，`FileMissRepository` 通过 `tokio::task::spawn_blocking` 桥接到异步世界
5. **tagged response** — 文件模式和 vlog 模式返回不同 JSON 形状，前端通过 `source` 字段区分
6. **snapshot 中的 MissNode 不变** — `layer_service.rs` 中的 `MissNode` 走 VictoriaMetrics PromQL 查询，与本次改动的 miss 日志详情查询是不同的用例，无需修改
7. **VlogRepository trait 保留** — 作为领域端口保留，当前通过 VlogMissRepository 间接使用，未来可直接用于非 Miss 的 vlog 查询场景
