# save-service

Purpose: authenticated cloud-save synchronization for game clients.

## Responsibilities
- Validate and merge client save envelopes with server envelopes.
- Persist merged server state via pluggable storage adapters.
- Expose session-protected HTTP sync endpoint.

## API
- `createSaveService(options)`
- `createSaveHttpServer(options)`
- `POST /v1/save/sync`
- `GET /healthz`

## Storage
- `InMemorySaveStore`: test/dev usage.
- `JsonFileSaveStore`: durable local/file-backed usage.
- `PostgresSaveStore`: shared durable store for multi-instance deployments.

Production note:
- Use `PostgresSaveStore` for multi-instance deployments. Memory and JSON-file stores are single-process adapters; two processes must never share a JSON file.

## Run
- `npm run start:save`

Required env:
- Session verifier config (one of):
  - `SESSION_SECRET` (legacy HS256)
  - `SESSION_PUBLIC_KEY_PEM` (RS256 static public key)
  - `SESSION_JWKS_URL` (RS256 JWKS endpoint)

Optional env:
- `HOST` (default `0.0.0.0`)
- `PORT` (default `8090`)
- `SESSION_ISSUER` (default `terapixel.identity`)
- `SESSION_AUDIENCE` (default `terapixel.game`)
- `CLOCK_SKEW_SECONDS` (default `10`)
- `SESSION_JWKS_TTL_SECONDS` (default `600`)
- `SESSION_ALLOW_LEGACY_HS256` (default `true`)
- `SESSION_REQUIRE_SUB` (default `false`)
- `SESSION_ALLOW_LEGACY_NAKAMA_SUBJECT` (default `true`)
- `SESSION_LEGACY_CUTOFF_UTC` (optional UTC timestamp; when reached, defaults flip to strict mode)
- `SESSION_LEGACY_CUTOFF_PROD_UTC` (optional prod-specific cutoff override)
- `SESSION_LEGACY_CUTOFF_STAGING_UTC` (optional staging-specific cutoff override)
- `SESSION_POLICY_ENVIRONMENT` (optional explicit policy environment selector)
- `CORS_ALLOWED_ORIGINS` (`*` or comma-separated origin allowlist)
- `SAVE_STORE_TYPE` (`memory`, `file`, or `postgres`, default `memory`)
- `SAVE_STORE_FILE_PATH` (used when `SAVE_STORE_TYPE=file`)
- `SAVE_STORE_TABLE` (used when `SAVE_STORE_TYPE=postgres`, default `save_envelopes`)
- `DATABASE_URL` (required when `SAVE_STORE_TYPE=postgres`)
- `PLATFORM_CONFIG_STORE_TYPE` (`none`|`postgres`|`http`, default `none`)
- `PLATFORM_CONFIG_SERVICE_URL` (required for `http` mode)
- `PLATFORM_CONFIG_INTERNAL_KEY` (required for `http` mode)
- `PLATFORM_CONFIG_ENVIRONMENT` (`staging`|`prod`, default `prod`)
- `PLATFORM_CONFIG_CACHE_TTL_SECONDS` (default `15`)

When `PLATFORM_CONFIG_STORE_TYPE` is not `none`, `game_id` must be an onboarded active title
in control-plane for save read/write requests.


## Revision-safe writes and migration

Sync reads a snapshot, merges the original client envelope, and writes only if
that snapshot still matches. PostgreSQL uses `INSERT ... ON CONFLICT DO NOTHING`
for absent rows and a conditional `UPDATE` for existing rows (revision and JSONB
snapshot equality). Memory/file adapters perform the same check in their mutation
critical section. Snapshot matching also rejects deletion/recreation with a reused
revision and different content. A losing request rereads and remerges rather than
retrying a stale computed write. No database schema migration is required.

The service defaults to five write attempts; `maxWriteAttempts` is a constructor-only
integer from 1 through 20. Exhaustion returns HTTP 409 with
`error.code = "save_conflict"`, `retryable: true`, and the latest `envelope` (possibly
null). Clients should retain their local save and retry with backoff. Successful
response fields and source values are unchanged. Malformed envelope metadata,
including string/fractional/unsafe revisions or schema versions, returns 422;
unexpected storage failures return 500 rather than masquerading as validation errors.
Previously persisted malformed metadata needs offline inspection/correction before
rollout; this patch does not silently coerce it.

Custom adapters must implement `compareAndSwap(envelope, expectedRevision,
expectedEnvelope)` and return `{ applied: true, envelope }` or `{ applied: false }`.
Null expected revision/snapshot means absent. Existing-row writes must atomically
check both supplied revision and snapshot. `put` remains an explicit unconditional
replacement API for setup/legacy compatibility; concurrent sync must never use it.
Profile migration additionally requires `listByProfile` and `migrateProfileGame`.
All built-in adapters implement these contracts. JSON mutations stage a complete
snapshot, rename the file, then publish memory state; failed persistence leaves the
committed state intact and the queue usable. Atomic rename does not provide fsync
power-loss durability or cross-process locking.

Per-game profile migration atomically writes the combined destination and removes
the source. PostgreSQL uses one checked-out client and sorted row locks throughout,
with rollback/release on error. Missing destination insert races roll back and retry
from fresh rows. This orders locks consistently for current migration paths without
a table-wide writer lock. Lock latency/deadlock behavior still needs real PostgreSQL
validation. Multi-game migration can finish earlier games before a later failure;
it is not a cross-game or cross-service saga. A late secondary-profile save can
recreate secondary data; canonical redirection/resumable orchestration is separate
work. The existing merge policy is preserved: known progress counters use maxima,
unknown keys are retained and the fresher envelope wins conflicts. This does not
sum independent increments or implement arbitrary field CRDTs.

## Local verification and release gate

Run the Node 20 suite with `node --test`. Tests include deterministic simultaneous
first/existing saves, remerge retries, reused-revision snapshots, bounded contention,
file failure recovery, migration races, route responses, and scripted PostgreSQL
transaction/SQL checks. Scripted checks are not engine integration coverage.

`test/postgres-save-integration.test.js` is opt-in with
`SAVE_TEST_LOCAL_DATABASE_URL` pointing to an approved, already-running disposable
loopback PostgreSQL database. It creates/drops an isolated schema and verifies real
concurrent CAS and migration rollback via an injected delete failure. URL query
overrides are rejected and `DATABASE_URL` is never used as a fallback. Database
startup approval is pending; these tests have not run and remain a release gate.
No database, deployment, credential or live configuration changes are part of this
patch. This local branch depends on integrated review commit `90feb4d` for the shared
pinned-client transaction helper; it is not a standalone patch against original main.
