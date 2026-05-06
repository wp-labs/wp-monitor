#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"

COMPOSE_FILE=""
COMPOSE_CMD=()

usage() {
  echo "用法: ./start.sh [-f] [main|alpha|beta]" >&2
}

ensure_docker_exists() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "未检测到 docker，请先安装 Docker。" >&2
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "检测到 docker 命令已安装，但 Docker 未启动，请先启动 Docker 后再重试。" >&2
    exit 1
  fi
}

resolve_compose_cmd() {
  ensure_docker_exists

  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
    return 0
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
    return 0
  fi

  echo "未检测到 docker compose 或 docker-compose，请先安装 Docker Compose。" >&2
  exit 1
}

trim_trailing_cr() {
  local value="$1"
  printf '%s' "${value%$'\r'}"
}

resolve_compose_file() {
  local channel="${1:-main}"

  case "$channel" in
    main | alpha | beta)
      COMPOSE_FILE="$SCRIPT_DIR/docker-compose-${channel}.yml"
      ;;
    *)
      echo "不支持的环境参数: $channel" >&2
      usage
      exit 1
      ;;
  esac

  if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "未找到 compose 文件: $COMPOSE_FILE" >&2
    exit 1
  fi
}

create_env_if_missing() {
  local force_render="${1:-0}"
  local env_file="$SCRIPT_DIR/.env"
  local env_example_file="$SCRIPT_DIR/.env.example"
  local prompt_input="/dev/tty"
  local line=""
  local description=""
  local description_mode="interactive"
  local key=""
  local default_value=""
  local user_value=""
  local intro_shown="0"
  local generated_lines=()

  if [[ -f "$env_file" && "$force_render" != "1" ]]; then
    echo "检测到已存在的 .env，跳过生成。"
    return 0
  fi

  if [[ -f "$env_file" && "$force_render" == "1" ]]; then
    echo "检测到 -f，重新渲染 .env。"
  fi

  if [[ ! -f "$env_example_file" ]]; then
    echo "未找到 .env.example，无法生成 .env。" >&2
    exit 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line=$(trim_trailing_cr "$line")

    if [[ -z "$line" ]]; then
      continue
    fi

    if [[ "$line" =~ ^#[[:space:]]*\$\{(.*)\}$ ]]; then
      description="${BASH_REMATCH[1]}"
      description_mode="interactive"
      continue
    fi

    if [[ "$line" =~ ^#[[:space:]]*\{(.*)\}$ ]]; then
      description="${BASH_REMATCH[1]}"
      description_mode="auto"
      continue
    fi

    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      default_value="${BASH_REMATCH[2]}"
      user_value="$default_value"

      if [[ "$description_mode" == "interactive" ]]; then
        if [[ "$intro_shown" == "0" ]]; then
          echo "请输入以下配置，直接回车使用默认值。"
          intro_shown="1"
        fi

        if [[ ! -r "$prompt_input" ]]; then
          echo "当前终端不可交互，无法根据 .env.example 生成 .env。" >&2
          exit 1
        fi

        if [[ -n "$description" ]]; then
          read -r -p "[${description}] (默认值：${default_value}): " user_value < "$prompt_input"
        else
          read -r -p "[${key}] (默认值：${default_value}): " user_value < "$prompt_input"
        fi

        if [[ -z "$user_value" ]]; then
          user_value="$default_value"
        fi
      fi

      if [[ -n "$description" ]]; then
        generated_lines+=("# ${description}")
      fi
      generated_lines+=("${key}=${user_value}")
      description=""
      description_mode="interactive"
    fi
  done < "$env_example_file"

  : > "$env_file"
  if [[ ${#generated_lines[@]} -gt 0 ]]; then
    printf '%s\n' "${generated_lines[@]}" > "$env_file"
  fi
  echo "配置已经保存到 .env 中。"
}

start_compose() {
  echo "开始启动服务..."
  "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" up -d
}

print_access_entries() {
  local channel
  channel="${1:-main}"
  printf '\n访问入口：\n'
  case "$channel" in
    alpha)
      printf '  - wparse观测平台: http://localhost:10428 (宿主机端口: 10428)\n'
      printf '其他非关键服务入口：\n'
      printf '  - victoria-metrics: http://localhost:18429 (宿主机端口: 18429)\n'
      printf '  - victoria-logs: http://localhost:19429 (宿主机端口: 19429)\n'
      ;;
    beta)
      printf '  - wparse观测平台: http://localhost:10528 (宿主机端口: 10528)\n'
      printf '其他非关键服务入口：\n'
      printf '  - victoria-metrics: http://localhost:18439 (宿主机端口: 18439)\n'
      printf '  - victoria-logs: http://localhost:19439 (宿主机端口: 19439)\n'
      ;;
    main)
      printf '  - wparse观测平台: http://localhost:10628 (宿主机端口: 10628)\n'
      printf '其他非关键服务入口：\n'
      printf '  - victoria-metrics: http://localhost:18449 (宿主机端口: 18449)\n'
      printf '  - victoria-logs: http://localhost:19449 (宿主机端口: 19449)\n'
      ;;
    *)
      printf '  - 未知环境: %s\n' "$channel"
      ;;
  esac
}

main() {
  local channel="main"
  local force_render="0"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f)
        force_render="1"
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      main|alpha|beta)
        channel="$1"
        ;;
      *)
        echo "不支持的参数: $1" >&2
        usage
        exit 1
        ;;
    esac
    shift
  done

  resolve_compose_file "$channel"
  resolve_compose_cmd
  create_env_if_missing "$force_render"
  start_compose
  print_access_entries "$channel"
}

main "$@"
