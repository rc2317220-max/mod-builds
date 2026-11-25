#!/usr/bin/env bash
# Keep enough RAM for large rustc processes; never change runtime optimization.
preview4_jobs() {
  local cpus memory jobs
  cpus=$(nproc)
  memory=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  jobs=3
  if [ "$cpus" -lt 3 ]; then jobs=$cpus; fi
  if [ "$memory" -lt 10000000 ] && [ "$jobs" -gt 2 ]; then jobs=2; fi
  if [ "$cpus" -ge 4 ] && [ "$memory" -ge 25165824 ]; then jobs=4; fi
  printf '%s\n' "$jobs"
}
