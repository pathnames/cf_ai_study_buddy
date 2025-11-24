#!/usr/bin/env bash

# Usage:
#   ./test_study_agent.sh https://YOUR_WORKER_URL

set -euo pipefail

BASE_URL="${1:-}"

if [[ -z "$BASE_URL" ]]; then
  echo "ERROR: Provide your Worker base URL."
  exit 1
fi

have_jq=0
if command -v jq >/dev/null 2>&1; then
  have_jq=1
fi

print_json() {
  if [[ $have_jq -eq 1 ]]; then
    echo "$1" | jq .
  else
    echo "$1"
  fi
}

hr() { echo "------------------------------------------------------------"; }

# NEW: Reset state
hr
echo "RESET: clearing KV for demo-user"
resp="$(curl -sS "${BASE_URL}/debug/reset")"
print_json "$resp"

# 1) Health
hr
echo "1) HEALTH CHECK: GET /api/health"
resp="$(curl -sS "${BASE_URL}/api/health")"
print_json "$resp"

# 2) Initial empty KV
hr
echo "2) INITIAL STATE:"
resp="$(curl -sS "${BASE_URL}/debug/state")"
print_json "$resp"

# 3) Create new plan
hr
echo "3) CREATE PLAN"
resp="$(
curl -sS -X POST "${BASE_URL}/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"I have 60 minutes to study binary search."}'
)"
print_json "$resp"

# 4) Revise plan
hr
echo "4) REVISE PLAN"
resp="$(
curl -sS -X POST "${BASE_URL}/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"Make the plan faster and more practical."}'
)"
print_json "$resp"

# 5) Log outcome
hr
echo "5) LOG OUTCOME"
resp="$(
curl -sS -X POST "${BASE_URL}/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"I got most of it done but slowed down at the end."}'
)"
print_json "$resp"

# 6) Analyze patterns
hr
echo "6) ANALYZE PATTERNS"
resp="$(
curl -sS -X POST "${BASE_URL}/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"Analyze my study habits so far."}'
)"
print_json "$resp"

# 7) Final debug dump
hr
echo "7) FINAL STATE"
resp="$(curl -sS "${BASE_URL}/debug/state")"
print_json "$resp"

echo
echo "Done!"
