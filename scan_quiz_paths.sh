#!/usr/bin/env bash
base="https://tds-llm-analysis.s-anand.net/demo"
cands=(
  "$base"
  "$base/start"
  "$base/quiz"
  "$base/task"
  "$base/q1"
  "$base/first"
  "$base/1"
  "$base/quiz1"
  "$base/index"
  "$base/page"
)
for p in "${cands[@]}"; do
  echo "----- $p -----"
  body=$(curl -sS "$p")
  echo "$body" | sed -n '1,8p'
  echo "Markers:"
  echo "$body" | grep -Ei "atob|#result|download|submit|base64" || echo "  none"
  echo
done
