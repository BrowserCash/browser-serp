#!/bin/bash
URL="http://localhost:8080/api/v1/search"
RUNS=5

function run_bench() {
  local COUNT=$1
  local TOTAL_TIME=0
  local SUCCESS_RUNS=0
  local PAYLOAD='{"q":"test","count":'$COUNT'}'
  
  echo "Benchmarking count=$COUNT ($RUNS runs)..."
  
  for ((i=1; i<=RUNS; i++)); do
    curl -s -o response.json -w "%{http_code} %{time_total}" -X POST "$URL" -H "Content-Type: application/json" -d "$PAYLOAD" > stats.txt
    
    CODE=$(awk '{print $1}' stats.txt)
    TIME=$(awk '{print $2}' stats.txt)
    
    if [ "$CODE" != "200" ]; then
      echo "Run $i: FAILED (HTTP $CODE) - ${TIME}s"
      continue
    fi

    REC_COUNT=$(jq '.web.results | length' response.json)
    
    echo "Run $i: ${REC_COUNT} results - ${TIME}s"
    
    if [ "$REC_COUNT" -ge "$COUNT" ]; then
      TOTAL_TIME=$(echo "$TOTAL_TIME + $TIME" | bc)
      SUCCESS_RUNS=$((SUCCESS_RUNS+1))
    else
      echo "  -> WARNING: Got fewer results than requested"
    fi
  done
  
  if [ "$SUCCESS_RUNS" -gt 0 ]; then
    AVG=$(echo "scale=3; $TOTAL_TIME / $SUCCESS_RUNS" | bc)
    echo "--------------------------------"
    echo "Average Time (Successful Runs): ${AVG}s"
  else
    echo "--------------------------------"
    echo "All runs failed quality check."
  fi
  echo ""
}

run_bench 5
run_bench 20
