#!/usr/bin/env bash
set -euo pipefail

# Enforce small, focused commits by default.
# Bypass explicitly when needed:
#   ALLOW_LARGE_CHANGE=1 git commit ...

if [[ "${ALLOW_LARGE_CHANGE:-}" == "1" ]]; then
  exit 0
fi

max_files="${ATOMIC_MAX_FILES:-8}"
max_lines="${ATOMIC_MAX_CHANGED_LINES:-300}"

if [[ "${1:-}" == "--staged" ]]; then
  file_count="$(git diff --cached --name-only | sed '/^$/d' | wc -l | tr -d ' ')"
  changed_lines="$(git diff --cached --shortstat | awk '{add+=$4; del+=$6} END {print add+del+0}')"
else
  file_count="$(git diff --name-only | sed '/^$/d' | wc -l | tr -d ' ')"
  changed_lines="$(git diff --shortstat | awk '{add+=$4; del+=$6} END {print add+del+0}')"
fi

if (( file_count > max_files || changed_lines > max_lines )); then
  echo "[atomic-check] Commit looks large: ${file_count} files, ${changed_lines} changed lines."
  echo "[atomic-check] Limits: ${max_files} files, ${max_lines} changed lines."
  echo "[atomic-check] Split into smaller commits, or bypass intentionally with:"
  echo "[atomic-check]   ALLOW_LARGE_CHANGE=1 git commit ..."
  exit 1
fi

exit 0
