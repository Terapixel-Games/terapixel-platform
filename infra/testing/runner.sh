#!/bin/sh
set -eu
node --version
npm --version
node infra/testing/postgres-check.mjs --preflight
npm run db:migrate
npm run db:migrate
node --test --test-reporter=spec infra/testing/postgres-check.mjs
npm test
