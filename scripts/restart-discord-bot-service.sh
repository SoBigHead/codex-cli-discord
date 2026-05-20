#!/usr/bin/env bash
set -euo pipefail

UID_VALUE="$(id -u)"
PROJECT_LABEL_PREFIX="com.atou.agents-in-discord"
LEGACY_LABEL_PREFIX="com.atou.codex-discord-bot"
USER_AGENTS_DIR="${HOME}/Library/LaunchAgents"

resolve_label() {
  local raw="${1:-}"
  case "${raw}" in
    codex|main|"${PROJECT_LABEL_PREFIX}"|"${LEGACY_LABEL_PREFIX}")
      printf '%s\n' "${PROJECT_LABEL_PREFIX}"
      ;;
    claude|"${PROJECT_LABEL_PREFIX}.claude"|"${LEGACY_LABEL_PREFIX}.claude")
      printf '%s\n' "${PROJECT_LABEL_PREFIX}.claude"
      ;;
    antigravity|agy|"${PROJECT_LABEL_PREFIX}.antigravity")
      printf '%s\n' "${PROJECT_LABEL_PREFIX}.antigravity"
      ;;
    gemini|"${PROJECT_LABEL_PREFIX}.gemini"|"${LEGACY_LABEL_PREFIX}.gemini")
      if [[ -f "${USER_AGENTS_DIR}/${PROJECT_LABEL_PREFIX}.antigravity.plist" ]]; then
        printf '%s\n' "${PROJECT_LABEL_PREFIX}.antigravity"
      else
        printf '%s\n' "${PROJECT_LABEL_PREFIX}.gemini"
      fi
      ;;
    *)
      return 1
      ;;
  esac
}

restart_label() {
  local label="$1"
  local service_ref="gui/${UID_VALUE}/${label}"
  local plist_path="${USER_AGENTS_DIR}/${label}.plist"

  if /bin/launchctl print "${service_ref}" >/dev/null 2>&1; then
    /bin/launchctl kickstart -k "${service_ref}"
    return 0
  fi

  if [[ -f "${plist_path}" ]]; then
    /bin/launchctl bootstrap "gui/${UID_VALUE}" "${plist_path}"
    /bin/launchctl kickstart -k "${service_ref}"
    return 0
  fi

  printf 'restart-discord-bot-service: service not found: %s\n' "${label}" >&2
  return 1
}

main() {
  local raw="${1:-}"
  if [[ -z "${raw}" ]]; then
    printf 'usage: %s <codex|claude|antigravity|gemini|all|label>\n' "$0" >&2
    exit 64
  fi

  if [[ "${raw}" == "all" ]]; then
    restart_label "${PROJECT_LABEL_PREFIX}"
    restart_label "${PROJECT_LABEL_PREFIX}.claude"
    restart_label "${PROJECT_LABEL_PREFIX}.antigravity" || restart_label "${PROJECT_LABEL_PREFIX}.gemini"
    exit 0
  fi

  local label
  label="$(resolve_label "${raw}")" || {
    printf 'restart-discord-bot-service: unsupported target: %s\n' "${raw}" >&2
    exit 64
  }

  restart_label "${label}"
}

main "$@"
