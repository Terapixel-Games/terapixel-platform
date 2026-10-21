#!/bin/sh
set -eu
node --version
npm --version
node infra/testing/postgres-check.mjs --preflight
npm run db:migrate
npm run db:migrate
node --test --test-reporter=spec infra/testing/postgres-check.mjs
# All real-PG suites are mandatory in this harness. No fallback DATABASE_URL.
for name in IAP_TEST_LOCAL_DATABASE_URL CONSUMPTION_TEST_LOCAL_DATABASE_URL SAVE_TEST_LOCAL_DATABASE_URL; do
  eval "value=\${$name:-}"
  test -n "$value"
done
npm test > /tmp/platform-suite.log 2>&1 || { cat /tmp/platform-suite.log; exit 1; }
cat /tmp/platform-suite.log
node --input-type=module -e 'import fs from "node:fs"; import assert from "node:assert/strict"; const log=fs.readFileSync("/tmp/platform-suite.log","utf8"); assert.match(log,/skipped 0(?:\r?\n|$)/,"Docker data-stack suite must have zero skips"); for (const marker of ["real local PostgreSQL: atomic grants", "real local PostgreSQL: one-time identity", "real local PostgreSQL: IAP merge", "real local PostgreSQL: concurrent save"]) assert.ok(log.includes(marker), "missing mandatory suite: "+marker);'
