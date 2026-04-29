# GX ADM 使用指南

## 概述

`gx adm` 是基于 GXL 的版本管理与发布系统（定义在 `_gal/adm.gxl` 中）。日常开发用 `gx`（走 `work.gxl`），版本管理用 `gx -C ./_gal/adm.gxl` 或直接在项目根目录下执行。

本文档面向使用者，**不涉及实现细节**，只说明如何操作。

---

## 一、日常开发（不需要 adm）

```bash
# 构建、测试
gx
gx build
gx lint
```

这些是 `work.gxl` 的功能，与 adm 无关。

---

## 二、版本管理

### 查看当前版本

```bash
cat version.txt
gx -C ./_gal/adm.gxl    # 读取并打印版本
```

### 版本递增（核心操作）

| 命令 | 作用 | 示例 |
|------|------|------|
| `gx v_patch` | 递增修订号（修 bug 后） | 0.4.3 → 0.4.4 |
| `gx v_feat` | 递增次版本号（加功能后） | 0.4.3 → 0.5.0 |

执行后会自动：
1. 更新 `version.txt`
2. 同步更新 `Cargo.toml` 中的版本号
3. 同步更新 `docker-compose.yml` 中的镜像标签
4. `git commit` + `git push`

> 注意：不要手动改 `Cargo.toml` 的版本号，会被覆盖。**version.txt 是唯一版本源**。

---

## 三、发布上线

### 如果你在 wp-monitor（已配好 ver_adm 委托）

**无需指定文件路径**，直接在项目根目录执行：

```
gx v_patch              # 递增版本 (0.4.3 → 0.4.4)
gx v_feat               # 递增 feature 版本 (0.4.3 → 0.5.0)
gx tag_stable           # 打 stable 标签
gx tag_beta             # 打 beta 标签
gx tag_alpha            # 打 alpha 标签
```

### 如果项目没有委托配置（未继承 ver_adm）

需要指定配置文件：

```bash
gx -C ./_gal/adm.gxl v_patch
gx -C ./_gal/adm.gxl tag_stable
```

### 完整发布流程

#### alpha 发布（日常开发）

```bash
# 开发完成后，在 alpha 分支
gx v_patch              # 0.4.3 → 0.4.4
gx tag_alpha            # 打 v0.4.4-alpha 标签，触发 CI 发布
```

如果有多次迭代：

```bash
gx v_patch              # 0.4.3 → 0.4.4
gx v_patch              # 0.4.4 → 0.4.5
gx tag_alpha            # 打 v0.4.5-alpha
```

#### beta 发布（测试）

```bash
git checkout beta
git merge alpha

# 在 beta 分支打标签
gx tag_beta             # 打 v0.4.4-beta 标签
```

#### stable 发布（生产）

```bash
git checkout main
git merge beta

# 在 main 分支打标签
gx tag_stable           # 打 v0.4.4 标签
```

### 标签命名规则

| 类型 | 标签格式 | 示例 |
|------|---------|------|
| alpha | `v{版本号}-alpha` | `v0.4.4-alpha` |
| beta | `v{版本号}-beta` | `v0.4.4-beta` |
| stable | `v{版本号}` | `v0.4.4` |

---

## 四、命令速查表

| 命令 | 作用 | 什么时候用 |
|------|------|-----------|
| `gx` | 构建（debug） | 每天 |
| `gx build` | 运行测试 | 提交前 |
| `gx lint` | 代码检查 | 提交前 |
| `gx v_patch` | 递增 patch 版本 | 修完 bug 后 |
| `gx v_feat` | 递增 feature 版本 | 加完功能后 |
| `gx tag_stable` | 打 stable 标签 | 生产发布 |
| `gx tag_beta` | 打 beta 标签 | 测试发布 |
| `gx tag_alpha` | 打 alpha 标签 | 开发发布 |
| `cat version.txt` | 查看当前版本 | 任何时候 |

---

## 五、常见问题

**Q: 版本号没变但想打标签怎么办？**
直接执行对应 tag 命令即可，`tag_stable` / `tag_beta` / `tag_alpha` 只打标签，不递增版本。

**Q: 标签打错了怎么删除？**
```bash
git tag -d v0.4.4-alpha        # 删除本地
git push origin --delete v0.4.4-alpha  # 删除远程
```

**Q: CI 什么时候触发？**
当 `git push --tags` 推送到远程时，监听标签的 CI 工作流会自动触发构建和发布。
