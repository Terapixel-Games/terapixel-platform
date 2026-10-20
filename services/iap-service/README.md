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
Concurrent profile merges versus wallet operations are outside this patch and
have not been made transactionally safe. Subscription/provider/webhook behavior
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
