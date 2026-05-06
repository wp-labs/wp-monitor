#!/usr/bin/env bash

set -uo pipefail

# 持续发送思路：
# 1. 默认按远程 long-demo 的使用方式工作：优先依赖 PATH 或显式传入的 WPGEN_BIN。
# 2. 默认走 sample 模式，避免误用 rule 模式时要求 gen_rule.wpl。
# 3. 每次 wpgen 退出后等待一小段时间再重启，从外层保证持续发数。
# 4. 仅在用户明确允许的上下文里，才回退到仓库内构建二进制。

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

WPGEN_REPO_ROOT="${WPGEN_REPO_ROOT:-$DEFAULT_REPO_ROOT}"
WORK_ROOT="${WORK_ROOT:-$PWD}"
CONF_NAME="${CONF_NAME:-wpgen.toml}"
MODE="${MODE:-sample}"
WPGEN_BIN="${WPGEN_BIN:-}"
USE_CARGO_RUN="${USE_CARGO_RUN:-0}"
AUTO_BUILD="${AUTO_BUILD:-0}"
PRINT_STAT="${PRINT_STAT:-1}"
STAT_SEC="${STAT_SEC:-1}"
RESTART_DELAY_SECS="${RESTART_DELAY_SECS:-2}"
WPL_DIR="${WPL_DIR:-}"
SPEED_OVERRIDE="${SPEED_OVERRIDE:-}"
LINE_CNT_OVERRIDE="${LINE_CNT_OVERRIDE:-}"
MAX_RUNS="${MAX_RUNS:-0}"
RESOLVED_WPGEN_BIN=""

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

usage() {
  cat <<'EOF'
用法：
  直接运行：
    ./scripts/wpgen-keep-running.sh

  常用环境变量：
    MODE=rule|sample                     选择 wpgen 子命令，默认 sample
    WORK_ROOT=/path/to/demo              生成任务工作目录，默认当前目录
    CONF_NAME=wpgen.toml                 配置文件名，默认 wpgen.toml
    WPGEN_BIN=/path/to/wpgen             显式指定 wpgen 可执行文件
    WPGEN_REPO_ROOT=/path/to/warp-parse  warp-parse 仓库根目录，仅在构建或回退查找 target/ 下二进制时使用
    USE_CARGO_RUN=1                      改用 cargo run --bin wpgen -- ...
    AUTO_BUILD=1                         找不到 wpgen 时，允许在 WPGEN_REPO_ROOT 下自动 cargo build
    PRINT_STAT=1                         是否加 -p 打印统计，1=开启，0=关闭
    STAT_SEC=1                           统计打印间隔秒数
    WPL_DIR=./models/wpl                 可选，覆盖 --wpl
    SPEED_OVERRIDE=10000                 可选，覆盖 -s
    LINE_CNT_OVERRIDE=1000000            可选，覆盖 -n
    RESTART_DELAY_SECS=2                 每次退出后的重启等待秒数
    MAX_RUNS=0                           运行次数上限，0 表示无限重启

示例：
  1) 远程 demo 场景，PATH 里已有 wpgen：
     WORK_ROOT=/root/wp/wp-monitor/wp-examples/long-demo \
     ./scripts/wpgen-keep-running.sh

  2) 显式指定远程 wpgen 二进制：
     WORK_ROOT=/root/wp/wp-monitor/wp-examples/long-demo \
     WPGEN_BIN=/usr/local/bin/wpgen \
     ./scripts/wpgen-keep-running.sh

  3) demo 工程和 warp-parse 仓库分离，但允许自动构建：
     WORK_ROOT=/root/wp/wp-monitor/wp-examples/long-demo \
     WPGEN_REPO_ROOT=/root/wp/warp-parse \
     AUTO_BUILD=1 \
     ./scripts/wpgen-keep-running.sh

  4) 关闭统计输出，减少终端/日志增长：
     PRINT_STAT=0 ./scripts/wpgen-keep-running.sh
EOF
}

validate_mode() {
  case "$MODE" in
    rule|sample) ;;
    *)
      log "错误：MODE 只能是 rule 或 sample，当前值为 '$MODE'"
      exit 2
      ;;
  esac
}

repo_has_cargo_toml() {
  [[ -f "$WPGEN_REPO_ROOT/Cargo.toml" ]]
}

resolve_wpgen_bin() {
  local candidate
  local -a candidates=()

  if [[ -n "$WPGEN_BIN" ]]; then
    candidates+=("$WPGEN_BIN")
  fi

  if command -v wpgen >/dev/null 2>&1; then
    candidates+=("$(command -v wpgen)")
  fi

  candidates+=("$WPGEN_REPO_ROOT/target/debug/wpgen" "$WPGEN_REPO_ROOT/target/release/wpgen")

  for candidate in "${candidates[@]}"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      RESOLVED_WPGEN_BIN="$candidate"
      return 0
    fi
  done

  return 1
}

build_wpgen() {
  if ! repo_has_cargo_toml; then
    log "错误：在 '$WPGEN_REPO_ROOT' 下未找到 Cargo.toml，无法执行 cargo build"
    log "请显式设置 WPGEN_BIN=/path/to/wpgen，或设置正确的 WPGEN_REPO_ROOT=/path/to/warp-parse"
    return 1
  fi

  log "未找到可执行 wpgen，开始在 '$WPGEN_REPO_ROOT' 执行 cargo build --bin wpgen"
  if ! (
    cd "$WPGEN_REPO_ROOT" &&
    cargo build --bin wpgen
  ); then
    log "错误：构建 wpgen 失败"
    return 1
  fi

  if [[ -x "$WPGEN_REPO_ROOT/target/debug/wpgen" ]]; then
    RESOLVED_WPGEN_BIN="$WPGEN_REPO_ROOT/target/debug/wpgen"
    return 0
  fi

  log "错误：构建完成后仍未找到 '$WPGEN_REPO_ROOT/target/debug/wpgen'"
  return 1
}

append_optional_args() {
  if [[ "$PRINT_STAT" == "1" ]]; then
    CMD+=("-p")
  fi

  if [[ -n "$WPL_DIR" ]]; then
    CMD+=("--wpl" "$WPL_DIR")
  fi

  if [[ -n "$SPEED_OVERRIDE" ]]; then
    CMD+=("-s" "$SPEED_OVERRIDE")
  fi

  if [[ -n "$LINE_CNT_OVERRIDE" ]]; then
    CMD+=("-n" "$LINE_CNT_OVERRIDE")
  fi
}

prepare_runner() {
  validate_mode

  if [[ "$USE_CARGO_RUN" == "1" ]]; then
    if ! repo_has_cargo_toml; then
      log "错误：USE_CARGO_RUN=1 时，WPGEN_REPO_ROOT='$WPGEN_REPO_ROOT' 下必须存在 Cargo.toml"
      exit 2
    fi
    return 0
  fi

  if resolve_wpgen_bin; then
    return 0
  fi

  if [[ "$AUTO_BUILD" != "1" ]]; then
    log "错误：未找到可执行 wpgen"
    log "请优先设置 WPGEN_BIN=/path/to/wpgen，或确保 wpgen 已在 PATH 中"
    log "若你明确希望脚本自动构建，可设置 AUTO_BUILD=1 并提供正确的 WPGEN_REPO_ROOT"
    exit 2
  fi

  if ! build_wpgen; then
    exit 2
  fi
}

run_once() {
  if [[ "$USE_CARGO_RUN" == "1" ]]; then
    CMD=(cargo run --bin wpgen -- "$MODE" -w "$WORK_ROOT" -c "$CONF_NAME" --stat "$STAT_SEC")
    append_optional_args
    log "启动命令：cd '$WPGEN_REPO_ROOT' && ${CMD[*]}"
    (
      cd "$WPGEN_REPO_ROOT" &&
      "${CMD[@]}"
    )
    return $?
  fi

  CMD=("$RESOLVED_WPGEN_BIN" "$MODE" -w "$WORK_ROOT" -c "$CONF_NAME" --stat "$STAT_SEC")
  append_optional_args

  log "启动命令：${CMD[*]}"
  "${CMD[@]}"
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  prepare_runner

  if [[ "$USE_CARGO_RUN" != "1" ]]; then
    log "使用 wpgen 二进制：$RESOLVED_WPGEN_BIN"
  fi
  log "生成工作目录：$WORK_ROOT"

  local run_no=0

  trap 'log "收到退出信号，停止持续发送"; exit 0' INT TERM

  while true; do
    run_no=$((run_no + 1))

    if [[ "$MAX_RUNS" -gt 0 && "$run_no" -gt "$MAX_RUNS" ]]; then
      log "达到 MAX_RUNS=$MAX_RUNS，停止运行"
      break
    fi

    log "第 $run_no 次启动 wpgen"
    if run_once; then
      log "wpgen 正常退出，${RESTART_DELAY_SECS}s 后自动重启"
    else
      local exit_code=$?
      log "wpgen 异常退出，exit_code=$exit_code，${RESTART_DELAY_SECS}s 后自动重启"
    fi

    sleep "$RESTART_DELAY_SECS"
  done
}

main "$@"
