#!/bin/bash

cd /home/nev3r/projects/dify/web

echo "🧪 Full PDF Matching Test Suite"
echo "Testing all chunks in database..."
echo ""

# Results arrays
declare -a passed_chunks
declare -a failed_chunks
declare -a failed_details
declare -i total=0 passed=0 failed=0 skipped=0

# Test chunks 1-43 (maximum in database)
for i in {1..43}; do
  result=$(node scripts/test-matching-logic.js --chunkId=$i 2>&1)

  # Check if chunk exists and is testable
  if echo "$result" | grep -q "QUALITY METRICS"; then
    total=$((total + 1))

    # Extract metrics
    match_rate=$(echo "$result" | grep "Block Match Rate" | awk '{print $NF}' | tr -d '()')
    avg_score=$(echo "$result" | grep "Average Score" | awk '{print $NF}')
    coverage=$(echo "$result" | grep "Coverage:" | awk '{print $NF}' | tr -d '%')

    # Check if passed
    if echo "$result" | grep -q "✅ PASS"; then
      passed=$((passed + 1))
      passed_chunks+=("$i")
      echo "✅ Chunk $i: PASS (Match: $match_rate, Score: $avg_score, Cov: $coverage%)"
    else
      failed=$((failed + 1))
      failed_chunks+=("$i")
      failed_details+=("Chunk $i: Match=$match_rate, Score=$avg_score, Cov=$coverage%")
      echo "❌ Chunk $i: FAIL (Match: $match_rate, Score: $avg_score, Cov: $coverage%)"
    fi
  elif echo "$result" | grep -q "Skipping.*image"; then
    skipped=$((skipped + 1))
    echo "⏭️  Chunk $i: SKIP (image)"
  elif echo "$result" | grep -q "Error"; then
    # No more chunks or error
    break
  fi
done

echo ""
echo "=========================================="
echo "FINAL RESULTS"
echo "=========================================="
echo "Total text chunks: $total"
echo "Passed: $passed ($(( passed * 100 / total ))%)"
echo "Failed: $failed ($(( failed * 100 / total ))%)"
echo "Skipped (images): $skipped"
echo ""

if [ $failed -gt 0 ]; then
  echo "Failed chunks analysis:"
  for detail in "${failed_details[@]}"; do
    echo "  - $detail"
  done
  echo ""
fi

echo "Passed chunks: ${passed_chunks[*]}"
echo "Failed chunks: ${failed_chunks[*]}"
echo "=========================================="

# Calculate success rate
if [ $total -gt 0 ]; then
  success_rate=$(( passed * 100 / total ))
  if [ $success_rate -ge 80 ]; then
    echo "✅ Overall: GOOD ($success_rate% pass rate)"
  elif [ $success_rate -ge 60 ]; then
    echo "⚠️  Overall: ACCEPTABLE ($success_rate% pass rate)"
  else
    echo "❌ Overall: POOR ($success_rate% pass rate)"
  fi
fi
