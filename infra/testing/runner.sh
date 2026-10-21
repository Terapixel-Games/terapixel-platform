#!/bin/sh
set -eu
node --version
npm --version
node infra/testing/postgres-check.mjs --preflight
npm run db:migrate
npm run db:migrate
node --test --test-reporter=spec infra/testing/postgres-check.mjs
npm test > /tmp/platform-suite.log 2>&1 || { cat /tmp/platform-suite.log; exit 1; }
cat /tmp/platform-suite.log
node --input-type=module -e 'import fs from "node:fs"; import assert from "node:assert/strict"; assert.match(fs.readFileSync("/tmp/platform-suite.log","utf8"),/skipped 0(?:\r?\n|$)/,"Compose suite must have zero skips");'
