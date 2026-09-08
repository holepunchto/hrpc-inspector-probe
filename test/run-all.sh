#!/usr/bin/env bash
# CI gate for hrpc-inspector-probe. Non-zero exit blocks a release.
set -u
cd "$(dirname "$0")"
fail=0
run() { echo "--- $1"; if eval "$2"; then echo "    PASS"; else echo "    FAIL"; fail=1; fi; echo; }

echo "=== hrpc-inspector-probe (L1 taps + L2 collector) ==="
echo "Node $(node --version)"
echo

run "clock.test.mjs (HLC + offset estimation)"                  "node clock.test.mjs"
run "clock-skew.test.mjs (offset/skew + adversarial)"           "node clock-skew.test.mjs"
run "correlator.test.mjs (L2 memory bounds + timeouts)"         "node correlator.test.mjs"
run "redactor.test.mjs (peer/url/body redaction)"               "node redactor.test.mjs"
run "flush-guard.test.mjs (flush timer never throws)"           "node flush-guard.test.mjs"
run "probe.test.mjs (L1 adapter contract)"                      "node probe.test.mjs"
run "transport-framing.test.mjs (framing + capabilities)"       "node transport-framing.test.mjs"
run "hub-e2e.test.mjs (exporter -> hub wire contract)"          "node hub-e2e.test.mjs"
run "multipeer-merge.test.mjs (multi-peer HLC merge)"           "node multipeer-merge.test.mjs"

if [ $fail -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "VERIFICATION FAILED"; fi
exit $fail
