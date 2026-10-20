# identity-gateway

Purpose: verify provider identity assertions or Nakama identity assertions and mint internal session tokens.

## Responsibilities
- Verify CrazyGames JWTs against JWKS keys.
- Map provider identities to internal player IDs.
- Accept Nakama user identities and mint sessions without vendor exposure.
- Generate and redeem account merge pairing codes.
- Merge secondary profiles into primary profile.
- Mint short-lived player session tokens for downstream services.
- Expose auth HTTP endpoint.

## API
- `createIdentityGatewayService(options)`
- `createIdentityGatewayHttpServer(options)`
- `POST /v1/auth/crazygames`
- `POST /v1/auth/nakama`
- `GET /v1/web/login` (browser entrypoint; sends magic link when `email` query is provided)
- `POST /v1/web/login/start` (API entrypoint; starts magic link)
- `GET /v1/web/session` (cookie session status)
- `POST /v1/web/logout` (clear cookie session)
- `POST /v1/account/magic-link/start` (auth required)
- `POST /v1/account/magic-link/complete` (auth required)
- `GET /v1/account/magic-link/consume?ml_token=...` (email-click endpoint)
- `POST /v1/identity/internal/username/validate` (`x-admin-key` required)
- `POST /v1/account/merge/code` (auth required)
- `POST /v1/account/merge/redeem` (auth required)
- `GET /.well-known/jwks.json` (session signing public keys)
- `GET /healthz`

## Run
- `npm run start:identity`

Required env:
- `CRAZYGAMES_EXPECTED_AUDIENCE`
- Session signing config:
  - HS mode: `SESSION_SECRET`
  - RS mode: `SESSION_SIGNING_ALG=RS256`, `SESSION_SIGNING_KEY_ID`, `SESSION_SIGNING_KEY_PEM`

Optional env:
- `HOST` (default `0.0.0.0`)
- `PORT` (default `8080`)
- `BODY_LIMIT_BYTES` (default `65536`)
- `CRAZYGAMES_JWKS_URL` (default CrazyGames JWKS endpoint)
- `CRAZYGAMES_EXPECTED_ISSUER` (default CrazyGames issuer URL)
- `JWKS_TTL_SECONDS` (default `600`)
- `CLOCK_SKEW_SECONDS` (default `10`)
- `CORS_ALLOWED_ORIGINS` (`*` or comma-separated origin allowlist)
- `SESSION_ISSUER` (default `terapixel.identity`)
- `SESSION_AUDIENCE` (default `terapixel.game`)
- `SESSION_TTL_SECONDS` (default `3600`)
- `SESSION_SIGNING_ALG` (`HS256`|`RS256`, default `HS256` unless private key is provided)
- `SESSION_SIGNING_KEY_ID` (required for `RS256`)
- `SESSION_SIGNING_KEY_PEM` (required for `RS256`; PEM, `\n` accepted)
- `SESSION_PRIVATE_KEY_PEM` (alias of `SESSION_SIGNING_KEY_PEM`)
- `SESSION_PUBLIC_KEY_PEM` (optional explicit verifier/JWKS public key; derived from private key when omitted)
- `SESSION_JWKS_PATH` (default `/.well-known/jwks.json`)
- `SESSION_ALLOW_LEGACY_HS256` (default `true`)
- `SESSION_REQUIRE_SUB` (default `false`)
- `SESSION_ALLOW_LEGACY_NAKAMA_SUBJECT` (default `true`)
- `SESSION_LEGACY_CUTOFF_UTC` (optional UTC timestamp; when reached, defaults flip to strict mode)
- `SESSION_LEGACY_CUTOFF_PROD_UTC` (optional prod-specific cutoff override)
- `SESSION_LEGACY_CUTOFF_STAGING_UTC` (optional staging-specific cutoff override)
- `SESSION_POLICY_ENVIRONMENT` (optional explicit policy environment selector)
- `WEB_AUTH_GAME_ID` (default `web`; used for web magic-link flow)
- `WEB_SESSION_COOKIE_NAME` (default `tpx_session`)
- `WEB_SESSION_COOKIE_DOMAIN` (e.g. `.terapixel.games`)
- `WEB_SESSION_COOKIE_PATH` (default `/`)
- `WEB_SESSION_COOKIE_SECURE` (default `true`)
- `WEB_SESSION_COOKIE_SAMESITE` (`Lax`|`Strict`|`None`, default `Lax`)
- `WEB_SESSION_COOKIE_HTTPONLY` (default `true`)
- `WEB_RETURN_ORIGINS` (comma-separated allowlist for `return_to` redirects)
- `IDENTITY_STORE_TYPE` (`memory` or `postgres`, default `memory`)
- `DATABASE_URL` (required for `IDENTITY_STORE_TYPE=postgres`)
- `INTERNAL_SERVICE_KEY` (shared admin key for downstream merge routes)
- `IAP_INTERNAL_MERGE_URL`
- `SAVE_INTERNAL_MERGE_URL`
- `FLAGS_INTERNAL_MERGE_URL`
- `TELEMETRY_INTERNAL_MERGE_URL`
- `MAGIC_LINK_FROM_EMAIL`
- `MAGIC_LINK_REPLY_TO_EMAIL`
- `MAGIC_LINK_SUBJECT` (default `Terapixel Games Magic Link`)
- `MAGIC_LINK_BASE_URL` (e.g. `https://terapixel.games/api/v1/account/magic-link/consume`)
- `MAGIC_LINK_MOBILE_BASE_URL` (optional app deep-link root)
- `MAGIC_LINK_SIGNING_SECRET`
- `MAGIC_LINK_TTL_SECONDS` (default `900`)
- `MAGIC_LINK_RATE_LIMIT_PER_HOUR` (default `5`)
- `USERNAME_BLOCKLIST_GLOBAL` (CSV or JSON array for all games)
- `USERNAME_BLOCKLIST_BY_GAME_JSON` (JSON object keyed by `game_id`)
- `MAGIC_LINK_DEFAULT_GAME_ID` (fallback routing key for notify targets)
- `MAGIC_LINK_NAKAMA_NOTIFY_TARGETS_JSON` (per-game callback targets; preferred for 1:N games)
- `MAGIC_LINK_NAKAMA_NOTIFY_URL` (Nakama RPC URL for magic-link completion event)
- `MAGIC_LINK_NAKAMA_NOTIFY_HTTP_KEY` (Nakama runtime HTTP key)
- `MAGIC_LINK_NAKAMA_NOTIFY_SECRET` (shared secret checked by Nakama module)
- `PLATFORM_CONFIG_STORE_TYPE` (`none`|`postgres`|`http`) runtime source of truth resolver
- `DATABASE_URL` (required for `PLATFORM_CONFIG_STORE_TYPE=postgres`)
- `PLATFORM_CONFIG_SERVICE_URL` (required for `http` mode; ignored for `postgres` mode)
- `PLATFORM_CONFIG_INTERNAL_KEY` (`http` mode `x-admin-key`; ignored for `postgres` mode)
- `PLATFORM_CONFIG_ENVIRONMENT` (`staging`|`prod`, default `prod`)
- `PLATFORM_CONFIG_CACHE_TTL_SECONDS` (default `15`)
- `PLATFORM_CONFIG_ENCRYPTION_KEY` (required to decrypt stored notify secrets)
- `SMTP_HOST` (Google relay: `smtp-relay.gmail.com`)
- `SMTP_PORT` (Google relay: `587`)
- `SMTP_USER` (optional when relay allowlists source IP)
- `SMTP_PASS` (optional when relay allowlists source IP)
- `SMTP_SECURE` (default `false`)
- `SMTP_REQUIRE_TLS` (default `true`)

Notes:
- Magic-link web completion redirect now returns only `tpx_auth=1` (no identity PII query params).
- Browser identity should hydrate via `GET /v1/web/session` cookie check.

## PostgreSQL transaction ownership and single-use consumption

Merge-code redemption and magic-link consumption use a checked-out PostgreSQL
client for BEGIN, row locking, validation, conditional consumption, helper calls
and COMMIT. The shared `withPostgresTransaction` helper rolls back errors and
releases in `finally`; a failed rollback discards the client while preserving the
original error. Both token SELECTs use `FOR UPDATE`, followed by a conditional
`used_at IS NULL` update with `RETURNING`. Reuse is rejected even if a stored
used timestamp is zero. Validation/write failure rolls back consumption, so the
same token/code remains usable if the failure occurred before commit.

Merge-code redemption also locks `identity_merges` in SHARE ROW EXCLUSIVE mode
while resolving both canonical profile IDs and writing the merge edge. This is
a table-wide writer lock, held only for the local database transaction; ordinary
reads continue. It intentionally trades brief merge-writer serialization for a
stable canonical lookup. Existing direct markMerged/service merge flows are not
converted into a cross-service saga by this patch.

Memory parity fixes recheck merge-code usage after asynchronous profile lookup
and validate missing magic-link profiles before marking the token used. Existing
return fields, public completion HTML/cookie behavior and expiry comparison are
preserved. No HTTP routes or session/provider authentication are changed here.

Scope ends at the local-store commit. A downstream migration, notification,
session-cookie or network failure after commit does not unconsume a token/code.
Reliable cross-service merges and retry/reconciliation jobs remain separate work.
A connection error around COMMIT can leave its outcome uncertain; do not assume
an error proves rollback. Request a fresh magic link if completion cannot be
recovered. No schema migration or live configuration changes are included.

Validation: `test/postgres-consumption.test.js` uses scripted clients to verify
same-client SQL, locks, conditional updates and rollback/release paths, plus real
in-memory concurrent-use tests. `test/identity-single-use-http.test.js` checks
unauthenticated public completion/cookie behavior and concurrent reuse rejection.
These mocks do not demonstrate PostgreSQL lock behavior.

`test/postgres-consumption-integration.test.js` provides two opt-in real database
tests for concurrent code/token use, transactional fault/retry, repeated wallet
merges and writer exclusion. They are skipped unless
`CONSUMPTION_TEST_LOCAL_DATABASE_URL` explicitly names an existing loopback DB
(no query-string overrides). Tests require the existing `pg` dependency and
permission to create/drop their own isolated schema. They never read DATABASE_URL
and never start a service. Run with Node 20:
`node --test test/postgres-consumption-integration.test.js`.
Real PostgreSQL execution remains unperformed and is a release gate.

Local tools inspected: PostgreSQL 14.8 (`postgres`, `initdb`, `pg_ctl`, `psql`)
and Docker 28.5.1 are installed. PostgreSQL did not respond on 127.0.0.1:5432 or
the default /tmp socket; the configured Docker daemon at localhost:4243 was also
unavailable. Options, requiring separate approval: create a disposable native
cluster in a task/tmp directory with a private socket, or start an isolated
PostgreSQL container once Docker is available. No service was started/installed,
no existing database cluster was modified and no credentials were generated.

References: https://node-postgres.com/features/transactions and
https://www.postgresql.org/docs/14/explicit-locking.html.
