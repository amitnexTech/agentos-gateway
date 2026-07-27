#!/usr/bin/env bash
# Sample a provider's real throughput over time, so a decision about which plan
# to buy rests on measured tok/s and stall frequency instead of a single probe.
#
#   scripts/baseline.sh [provider] [interval_seconds] [model ...]
#
# Appends to data/baseline-<provider>.log. Runs until killed.

set -u

cd "$(dirname "$0")/.."

PROVIDER="${1:-lemosol}"
INTERVAL="${2:-1800}"
shift 2 2>/dev/null || shift $# 
MODELS=("$@")
[ ${#MODELS[@]} -eq 0 ] && MODELS=(claude-sonnet-5 claude-fable-5)

OUT="data/baseline-${PROVIDER}.log"

echo "# started $(date -Is) provider=$PROVIDER interval=${INTERVAL}s models=${MODELS[*]}" >> "$OUT"

while true; do
  TS="$(date -Is)"
  node scripts/swap-probe.mjs "$PROVIDER" "${MODELS[@]}" 2>&1 \
    | grep -E "tok/s|ERROR" \
    | while IFS= read -r line; do echo "$TS $line"; done >> "$OUT"
  sleep "$INTERVAL"
done
