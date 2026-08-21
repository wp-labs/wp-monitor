#!/usr/bin/env bash

set -euo pipefail

readonly REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/wp-labs/wp-monitor.git}"
readonly SERVICE_NAME="wp-monitor"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: $0 <main|beta|alpha> [--render-only]" >&2
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

resolve_channel() {
  local requested_branch="$1"

  case "$requested_branch" in
    main)
      compose_channel="stable"
      tag_pattern='^v[0-9]+\.[0-9]+\.[0-9]+$'
      ;;
    beta)
      compose_channel="beta"
      tag_pattern='^v[0-9]+\.[0-9]+\.[0-9]+-beta([.-][0-9]+)?$'
      ;;
    alpha)
      compose_channel="alpha"
      tag_pattern='^v[0-9]+\.[0-9]+\.[0-9]+-alpha([.-][0-9]+)?$'
      ;;
    *)
      echo "Unsupported branch: $requested_branch" >&2
      usage
      exit 1
      ;;
  esac
}

resolve_latest_tag() {
  local remote_refs
  local tags

  echo "Querying tags for branch channel: $branch" >&2
  if ! remote_refs="$(git ls-remote --tags --refs "$REPOSITORY_URL")"; then
    echo "Failed to query tags from $REPOSITORY_URL" >&2
    exit 1
  fi

  tags="$(
    while IFS=$'\t' read -r _ ref; do
      printf '%s\n' "${ref#refs/tags/}"
    done <<< "$remote_refs" | grep -E "$tag_pattern" || true
  )"

  if [[ -z "$tags" ]]; then
    echo "No matching tag found for branch: $branch" >&2
    exit 1
  fi

  latest_tag="$(printf '%s\n' "$tags" | sort -V | tail -n 1)"
}

render_tag_templates() {
  local compose_file="$1"
  local version="$2"
  local line
  local next_line
  local rendered_template
  local temporary_file
  local template=""
  local marker_count=0
  local index
  local lines=()

  mapfile -t lines < "$compose_file"
  temporary_file="$(mktemp "${compose_file}.XXXXXX")"
  trap 'rm -f "${temporary_file:-}"' EXIT

  for ((index = 0; index < ${#lines[@]}; index++)); do
    line="${lines[index]}"

    if [[ "$line" =~ ^[[:space:]]*#[[:space:]]*(.*\$\{tag\}.*)[[:space:]]*$ ]]; then
      template="${BASH_REMATCH[1]}"
      template="${template%${template##*[![:space:]]}}"
      marker_count=$((marker_count + 1))
      printf '%s\n' "$line" >> "$temporary_file"

      if ((index + 1 >= ${#lines[@]})); then
        echo "Tag template at the end of $compose_file has no YAML variable below it" >&2
        exit 1
      fi

      index=$((index + 1))
      next_line="${lines[index]}"
      if [[ ! "$next_line" =~ ^([[:space:]]*[^#[:space:]][^:]*:[[:space:]]*).*$ ]]; then
        echo "Tag template must be immediately followed by a YAML variable: $line" >&2
        exit 1
      fi

      rendered_template="${template//\$\{tag\}/$version}"
      printf '%s%s\n' "${BASH_REMATCH[1]}" "$rendered_template" >> "$temporary_file"
      continue
    fi

    printf '%s\n' "$line" >> "$temporary_file"
  done

  if ((marker_count == 0)); then
    echo 'No # ...${tag}... template found in the compose file' >&2
    exit 1
  fi

  docker compose -f "$temporary_file" config --quiet
  chmod --reference="$compose_file" "$temporary_file"
  mv "$temporary_file" "$compose_file"
  trap - EXIT
}

main() {
  if [[ $# -lt 1 || $# -gt 2 ]]; then
    usage
    exit 1
  fi

  local -r branch="$1"
  local render_only="false"
  local compose_channel=""
  local tag_pattern=""
  local latest_tag=""
  local compose_file=""

  if [[ $# -eq 2 ]]; then
    if [[ "$2" != "--render-only" ]]; then
      echo "Unsupported option: $2" >&2
      usage
      exit 1
    fi
    render_only="true"
  fi

  require_command git
  require_command docker
  require_command grep
  require_command sort

  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose plugin is not available" >&2
    exit 1
  fi

  resolve_channel "$branch"
  compose_file="$SCRIPT_DIR/$compose_channel/docker-compose.yml"

  if [[ ! -f "$compose_file" ]]; then
    echo "Compose file not found: $compose_file" >&2
    exit 1
  fi

  resolve_latest_tag

  echo "Selected tag: $latest_tag"
  render_tag_templates "$compose_file" "$latest_tag"

  if [[ "$render_only" == "true" ]]; then
    echo "Rendered $compose_file with tag $latest_tag"
    exit 0
  fi

  echo "Pulling image for $SERVICE_NAME"
  docker compose -f "$compose_file" pull "$SERVICE_NAME"
  echo "Stopping $SERVICE_NAME"
  docker compose -f "$compose_file" down "$SERVICE_NAME"
  echo "Starting $SERVICE_NAME with tag $latest_tag"
  docker compose -f "$compose_file" up -d --no-deps "$SERVICE_NAME"
  docker compose -f "$compose_file" ps "$SERVICE_NAME"
}

main "$@"
