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

## Billing lifecycle hardening (stacked on atomic wallet writes)

Verification time comes from the service clock (`Date.now` by default). Tests may
inject `clock: () => unixSeconds` at service construction; request `now_seconds`,
`nowSeconds` and `expires_at` cannot override provider verification time or the
expiry returned by the Apple/Google adapters. Entitlement reads require both a
provider-active value and a valid future expiry. At exactly the expiry second,
`no_ads.active` becomes false without a new verification request. Historical
active subscriptions lacking a valid expiry now fail closed and require an
authorized provider reconciliation; they are not granted indefinite access.

PayPal's Orders adapter supports only the existing single-unit consumable flow:
a `COMPLETED` order containing one `COMPLETED` capture, with both order-unit and
capture amounts/currencies matching the catalog. `APPROVED`, authorizations,
pending/absent captures, partial/multiple captures and multi-unit orders are not
accepted. The existing order-ID transaction key is retained to avoid regranting
previously fulfilled orders under a new capture-ID namespace. Prices currently
use the catalog's two-decimal currency representation (the shipped catalog is
USD); other currency precision models need a separate implementation.

PayPal subscriptions are deliberately unsupported by this Orders adapter. A
client-provided expiry is never authoritative. Proper support requires the
Subscriptions API, a server-owned product/plan/account association and verified
billing-period/payment data; no duration is invented from a completed order.
Apple verification requires a matching receipt product and valid subscription
expiry, selecting the newest matching receipt line. Google checks the matching
subscription line, valid expiry and provider state: active, grace-period and
canceled-but-unexpired states may retain access; pending/paused/on-hold states do
not. Neither provider accepts client clock/expiry as entitlement authority.
Malformed HTTP request/payload shapes return 400; provider verification rejection
returns 422. Storage/server failures remain 500 and must not be classified as a
successful purchase.

### Webhooks are disabled, not fully integrated

All three webhook endpoints return 503 `webhook_not_configured` for valid JSON.
Malformed JSON/shapes return 400. The prior allow-all signature stub and broken
arrow-`this` purchase dispatch are removed. Neither signature-looking headers,
client profile/product fields, nor a native-looking provider envelope enables
processing. No signature verification is claimed by this implementation.

Before enabling events, implement and review native verification plus durable,
server-owned account/product association, replay/out-of-order handling and
reconciliation:

- Apple: verified signed App Store Server Notifications and app/environment
  binding, with transaction/subscription association to a platform account.
- Google: authenticated Pub/Sub push with the expected identity/audience,
  notification decoding and an authoritative Play Developer API lookup with
  package/product/account binding.
- PayPal: native webhook verification for the configured webhook identity and
  transmission data, followed by trusted merchant/order/subscription/account
  mapping. The legacy profile_id/product_id wrapper is not a native provider
  event contract and must not be trusted.

Renewals, refunds, revocations, missed-event replay and reconciliation are not
implemented here. Existing same-transaction deduplication does not update a
subscription on a later state change with the same transaction ID. Expiry checks
alone do not handle early revocation. Do not enable or expand live payments on
the basis of these mocks. Review app/package, merchant, product and account
binding and existing grants before rollout. Apple's legacy verifyReceipt API
remains in use and is deprecated; migration is a separate integration task.

Official contract references:

- PayPal Orders/captures: https://developer.paypal.com/api/orders/v2
- PayPal Subscriptions: https://developer.paypal.com/api/subscriptions/v1
- PayPal webhook verification: https://developer.paypal.com/api/webhooks/v1/
- Apple receipt API: https://developer.apple.com/documentation/appstorereceipts/verify-receipt
- Apple notifications: https://developer.apple.com/documentation/appstoreservernotifications/receiving-app-store-server-notifications
- Google subscription resource/states: https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2
- Google authenticated push: https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions

Validation uses provider HTTP/OAuth test doubles and local HTTP routes. It does
not exercise live provider verification or real webhook signatures. The real
PostgreSQL integration test remains unexecuted and is a release gate. No new
credentials, secrets, provider settings, deployments or system services are
created/configured. Publication waits for authorized GitHub authentication;
reviewed main commits must precede staging, then production.
