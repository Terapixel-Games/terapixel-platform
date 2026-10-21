#!/bin/sh
# Run from any directory. Every invocation owns a fresh project and log directory.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
mkdir -p reports/compose
run_dir=$(mktemp -d "$root/reports/compose/run-XXXXXXXX")
project="terapixel-test-$(basename "$run_dir" | tr '[:upper:]' '[:lower:]')"
compose() {
  if [ -n "${TEST_DOCKER_CONTEXT:-}" ]; then
    docker --context "$TEST_DOCKER_CONTEXT" compose --env-file /dev/null -p "$project" -f "$root/compose.test.yaml" "$@"
  else
    docker compose --env-file /dev/null -p "$project" -f "$root/compose.test.yaml" "$@"
  fi
}
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  compose logs --no-color > "$run_dir/containers.log" 2>&1 || true
  if ! compose down --volumes --remove-orphans --timeout 10 > "$run_dir/cleanup.log" 2>&1; then
    echo "Cleanup failed; inspect $run_dir/cleanup.log (project $project)" >&2
    [ "$status" -ne 0 ] || status=1
  fi
  echo "Project: $project; logs: $run_dir; exit: $status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
printf '%s\n' "$project" > "$run_dir/project.txt"
compose config > "$run_dir/config.yaml"
compose build runner > "$run_dir/build.log" 2>&1
compose up --abort-on-container-exit --exit-code-from runner --timeout 10 > "$run_dir/up.log" 2>&1
