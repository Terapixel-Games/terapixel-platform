# iap-service

Purpose: purchase verification and entitlement source of truth.

## API
- `GET /healthz`
- `GET /v1/iap/entitlements` (auth required)
- `POST /v1/iap/verify` (auth required)
- `POST /v1/iap/coins/adjust` (auth required)
- `POST /v1/iap/webhook/apple`
- `POST /v1/iap/webhook/google`
- `POST /v1/iap/webhook/paypal`
- `POST /v1/iap/internal/merge-profile` (`x-admin-key` required)

## Env
- Session verifier config (required; one of):
  - `SESSION_SECRET` (legacy HS256)
  - `SESSION_PUBLIC_KEY_PEM` (RS256 static public key)
  - `SESSION_JWKS_URL` (RS256 JWKS endpoint)
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
- `IAP_STORE_TYPE` (`memory`|`file`|`postgres`, default `memory`)
- `IAP_STORE_FILE_PATH` (for `file`)
- `DATABASE_URL` (for `postgres`)
- `IAP_ADMIN_KEY` (required for internal merge endpoint)
- `IAP_APPLE_SHARED_SECRET`
- `IAP_GOOGLE_CLIENT_EMAIL`
- `IAP_GOOGLE_PRIVATE_KEY`
- `IAP_PAYPAL_CLIENT_ID`
- `IAP_PAYPAL_CLIENT_SECRET`
- `PLATFORM_CONFIG_STORE_TYPE` (`none`|`postgres`|`http`, default `none`)
- `DATABASE_URL` (required for `PLATFORM_CONFIG_STORE_TYPE=postgres` and `IAP_STORE_TYPE=postgres`)
- `PLATFORM_CONFIG_SERVICE_URL` (for `http` mode, e.g. control-plane base URL)
- `PLATFORM_CONFIG_INTERNAL_KEY` (for `http` mode, sent as `x-admin-key`)
- `PLATFORM_CONFIG_ENVIRONMENT` (`staging`|`prod`, default `prod`)
- `PLATFORM_CONFIG_CACHE_TTL_SECONDS` (default `15`)
- `PLATFORM_CONFIG_ENCRYPTION_KEY` (required for `postgres` mode when decrypting provider secrets)

`/v1/iap/verify` also accepts optional `game_id`. When provided, the service enforces that
`product_id` belongs to that game and can resolve per-title provider credentials from control-plane.

## Export Target Gating
`/v1/iap/verify` accepts `export_target` and enforces provider allow-list:
- `ios` -> `apple`
- `android` -> `google`
- `poki` -> `paypal_web`
- `crazygames` -> `paypal_web`
- `web` -> `paypal_web`

## Atomic purchase grants and wallet adjustments

`verifyPurchase` and `adjustCoins` use the store contract
`applyTransaction(provider, externalTransactionId, record, effect)`. `effect` is
one coin delta (`{ coins: { gameId, delta } }`) or the existing normalized
subscription value. The successful deduplication record and benefit are committed
together; insufficient funds or a failed grant does not consume the success key.
Concurrent duplicate transactions apply once. Distinct concurrent spends use a
conditional debit and cannot spend more than the available wallet balance.
Integer deltas/balances use the existing PostgreSQL signed INT range.

PostgreSQL uses `pool.connect()` and one pinned client for BEGIN, dedupe INSERT,
conditional wallet UPDATE (or existing subscription write), and COMMIT. Errors
ROLLBACK before releasing; rollback failures discard the connection and preserve
the original error. A response/connection failure around COMMIT can leave the
caller uncertain about success; retry with the same key rather than a new key.
The committed record prevents a repeated grant after a successful commit.
No schema migration is required. Historical records that were already saved
without a matching grant are not repaired automatically by this patch.

The memory implementation publishes each operation without asynchronous gaps.
The JSON file implementation serializes these transactions, writes a staged
snapshot using the existing temporary-file/rename pattern, then publishes the
in-memory state. A failed snapshot write leaves the operation retryable. File
mode is single-instance/single-writer only; it provides no cross-process locking
or fsync-based power-loss durability. Legacy standalone store mutators remain
for existing setup/merge paths; do not compose them for purchase/wallet writes.
The file-store follow-up below serializes all mutations, including the existing
merge operation. PostgreSQL/memory profile merges versus wallet operations remain
outside this patch and have not been made transactionally safe. Subscription/provider/webhook behavior
and save/merge implementations are otherwise unchanged.

Validation:

- `node --test test/iap-atomicity.test.js test/postgres-iap-atomicity.test.js`:
  memory/file concurrency, fault and retry coverage plus scripted PostgreSQL
  pinned-client/rollback tests. The latter mocks SQL responses and does not prove
  real PostgreSQL lock behavior.
- `test/postgres-iap-integration.test.js` is an opt-in real PostgreSQL test. With
  dependencies installed and an already-running disposable local database,
  supply `IAP_TEST_LOCAL_DATABASE_URL` pointing only to loopback, with no URL query
  parameters, and run `node --test test/postgres-iap-integration.test.js`.
  It creates/drops an isolated schema, injects a grant failure with a database
  trigger, and tests concurrent duplicate grants/spends and funded retries.
  It never reads `DATABASE_URL` and is skipped unless explicitly configured.

No database/server, credentials, or live settings are provisioned by these changes.
Review and merge this independent patch to main before staging or production.


### File-store serialization follow-up

All JSON file-store mutations now share one staged queue: `applyTransaction`,
legacy `recordTransaction`, `addCoins`, `upsertSubscription` and `mergeProfiles`.
Reads observe the previous committed snapshot while a write is pending. Failure
leaves both live state and the prior file unchanged, and later operations can
retry. The existing merge runs on the isolated in-memory stage, so its internal
helper calls do not recursively enter the file queue or expose partial state.

This corrects a reproducible lost update: a staged debit of 40 from 100 followed
by an overlapping legacy credit of 10 previously published 60; it now persists
70, including after reload. Regression tests also cover queued transaction and
subscription writes, overlapping merges, and snapshot failures/retries for every
legacy mutator. No merge selection/entitlement rules are changed. Memory and
PostgreSQL merge concurrency, cross-process file locking and fsync durability
remain outside this follow-up. Real PostgreSQL integration remains unexecuted
and is a release gate, not a passing test.
## PostgreSQL profile-merge transaction ownership

The PostgreSQL store now pins profile merging to one checked-out client, including
subscription reads/writes. A SHARE ROW EXCLUSIVE lock on `iap_coin_balances` and
`iap_subscriptions` serializes merge writers and ordinary INSERT/UPDATE/DELETE
operations during the local transfer, including legacy writers without advisory
lock cooperation. This prevents two overlapping merges from copying the same
secondary balance or a wallet writer changing rows between copying and zeroing.
Subscription choice and `{ merged: true|false }` response semantics are unchanged.
Errors roll back the complete transfer and release the client; rollback failure
discards the connection without replacing the original error.

The table-wide locks are deliberately conservative and can delay grants/debits
for other profiles while a merge runs. There are no remote calls inside the
transaction. Validate this latency/locking tradeoff and the runtime DB role's
ability to take these locks before release; no permissions/configuration are
changed here. No schema migration is required.

This patch uses original main baseline `bfa6290`, without a wallet or billing
branch dependency. Its subscription-write helper extraction mirrors the wallet
atomicity patch, so integration should retain both the atomic wallet operation
and pinned merge helpers. This branch alone does not contain the earlier wallet
atomicity fix. All approved fixes still require review/integration into main
before staging and production.

A grant made to the secondary profile after merge commit stays on that profile;
this patch does not redirect late writes or implement durable merge jobs. The
cross-service coordinator, idempotent saga/reconciliation, memory-store merge
concurrency and JSON file-store follow-up are separate changes. Existing
subscription/provider/webhook behavior is unchanged.

`test/postgres-consumption.test.js` checks pinned SQL and injected failures using
scripted clients. Optional real local DB tests and installed-tool availability
are documented in the identity-gateway README. Real PostgreSQL concurrency,
rollback and lock behavior have not been executed here and remain a release gate.


## Data-safety review scope

This draft is stacked on the PR8 harness branch `test/docker-compose-local`.
It combines atomic wallet operations, serialized JSON mutations, pinned PostgreSQL
profile transfers and identity consumption, and revision-safe saves. It deliberately
excludes billing lifecycle commit `6c086b9`/`b477c66`: provider verification, webhook
processing, subscription clock/expiry behavior remain baseline main behavior and are
not certified by this PR. No blanket session game binding is included.

Mandatory Compose CI runs the real PostgreSQL atomicity/consumption/save tests;
purchase provider verification is mocked and never calls live providers. Historical
notes above about unexecuted PostgreSQL checks describe the original patch stage,
not the separately recorded local validation. Production-scale table-lock latency,
provider lifecycle correctness, cross-service merge recovery and rollout remain
separate review gates. No merge or deployment is authorized by this publication.
