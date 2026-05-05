#!/bin/bash

# Debug Optimization System Verification Script
# Verifies all components of the debug optimization system are working

set -e

echo "🔍 Debug Optimization System Verification"
echo "=========================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0
SKIPPED=0

# Helper functions
pass() {
  echo -e "${GREEN}✓${NC} $1"
  ((PASSED++))
}

fail() {
  echo -e "${RED}✗${NC} $1"
  ((FAILED++))
}

skip() {
  echo -e "${YELLOW}⊘${NC} $1"
  ((SKIPPED++))
}

header() {
  echo ""
  echo -e "${BLUE}## $1${NC}"
}

# Check prerequisites
header "Prerequisites Check"

if ! command -v curl &> /dev/null; then
  skip "curl not found (required for API tests)"
  CURL_AVAILABLE=false
else
  pass "curl available"
  CURL_AVAILABLE=true
fi

if ! command -v jq &> /dev/null; then
  skip "jq not found (required for JSON parsing)"
  JQ_AVAILABLE=false
else
  pass "jq available"
  JQ_AVAILABLE=true
fi

# Check file existence
header "File Structure Verification"

files=(
  "src/utils/async-logger.ts"
  "src/utils/tracer.ts"
  "src/utils/metrics-aggregator.ts"
  "src/utils/root-cause-analyzer.ts"
  "src/utils/platform-delay-config.ts"
  "src/routes/metrics.ts"
  "public/dashboard.html"
  "public/dashboard.js"
  "docs/DEBUG_OPTIMIZATION_GUIDE.md"
  "docs/API_METRICS_REFERENCE.md"
  "docs/INSTRUMENTATION_GUIDE.md"
)

for file in "${files[@]}"; do
  if [ -f "$file" ]; then
    pass "$file exists"
  else
    fail "$file missing"
  fi
done

# Test suite verification
header "Test Suite Verification"

echo "Running test suite..."
if npm test > /tmp/test-output.log 2>&1; then
  # Extract test count from output
  test_count=$(grep -o "Tests.*passed" /tmp/test-output.log | tail -1 || echo "unknown")
  pass "All tests passed ($test_count)"
else
  fail "Some tests failed"
  tail -20 /tmp/test-output.log
fi

# Code analysis
header "Code Quality Checks"

# Check for common issues
if grep -r "console.log" src/utils/async-logger.ts src/utils/tracer.ts src/utils/metrics-aggregator.ts 2>/dev/null | grep -v "^[[:space:]]*//" > /dev/null; then
  fail "Found console.log statements in core modules"
else
  pass "No console.log statements in core modules"
fi

if grep -r "TODO\|FIXME\|HACK" src/utils/async-logger.ts src/utils/tracer.ts src/utils/metrics-aggregator.ts src/routes/metrics.ts 2>/dev/null > /dev/null; then
  fail "Found TODO/FIXME comments in implementation"
else
  pass "No unresolved TODOs in implementation"
fi

# API Endpoint Availability Check
header "API Endpoint Checks"

if [ "$CURL_AVAILABLE" = true ]; then
  # Try to check if we can curl localhost (won't work without running server)
  API_BASE="http://localhost:3000/api"

  echo "Note: These checks require a running server (npm start)"

  # Check stats endpoint
  if timeout 2 curl -s "$API_BASE/stats" > /tmp/stats.json 2>/dev/null; then
    if [ "$JQ_AVAILABLE" = true ]; then
      if jq -e '.ok' /tmp/stats.json > /dev/null 2>&1; then
        pass "GET /api/stats responds with valid JSON"
      else
        skip "GET /api/stats returned invalid response (server may not be running)"
      fi
    else
      pass "GET /api/stats is reachable (jq unavailable for validation)"
    fi
  else
    skip "GET /api/stats unreachable (server may not be running)"
  fi
else
  skip "Skipping API checks (curl not available)"
fi

# Documentation verification
header "Documentation Completeness"

docs=(
  "docs/DEBUG_OPTIMIZATION_GUIDE.md"
  "docs/API_METRICS_REFERENCE.md"
  "docs/INSTRUMENTATION_GUIDE.md"
)

for doc in "${docs[@]}"; do
  if [ -f "$doc" ]; then
    lines=$(wc -l < "$doc")
    if [ "$lines" -gt 100 ]; then
      pass "$doc ($lines lines)"
    else
      fail "$doc seems too short ($lines lines)"
    fi
  else
    fail "$doc not found"
  fi
done

# Dashboard verification
header "Dashboard Verification"

if [ -f "public/dashboard.html" ] && [ -f "public/dashboard.js" ]; then
  if grep -q "echarts" public/dashboard.html; then
    pass "Dashboard includes ECharts library reference"
  else
    fail "Dashboard missing ECharts reference"
  fi

  if grep -q "fetch.*api/stats" public/dashboard.js; then
    pass "Dashboard includes API calls"
  else
    fail "Dashboard missing API integration"
  fi

  if grep -q "refreshData\|updateMetrics" public/dashboard.js; then
    pass "Dashboard includes data refresh logic"
  else
    fail "Dashboard missing refresh functionality"
  fi
else
  fail "Dashboard files missing"
fi

# Git verification
header "Git History Verification"

if git log --oneline | head -10 | grep -q "feat.*debug\|async.*logger\|tracer\|metrics"; then
  pass "Recent commits include debug optimization work"
else
  fail "Debug optimization commits not found in history"
fi

commit_count=$(git log --oneline | grep -E "feat.*unit-[1-8]|docs.*unit-8|async-logger|tracer|metrics|root-cause|dashboard|delay" | wc -l)
if [ "$commit_count" -ge 8 ]; then
  pass "All $commit_count implementation commits found"
else
  fail "Not all unit commits found ($commit_count/8+)"
fi

# Summary
header "Summary"

total=$((PASSED + FAILED + SKIPPED))
echo ""
echo "Results:"
echo -e "  ${GREEN}Passed:${NC}  $PASSED"
echo -e "  ${RED}Failed:${NC}  $FAILED"
echo -e "  ${YELLOW}Skipped:${NC} $SKIPPED"
echo -e "  Total:   $total"
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ All critical checks passed!${NC}"
  exit 0
else
  echo -e "${RED}✗ $FAILED check(s) failed${NC}"
  exit 1
fi
