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

### Nakama backend exchange authentication and rollout

`POST /v1/auth/nakama` is a backend-only exchange. Configure
`NAKAMA_EXCHANGE_KEYS_JSON` as a secret JSON object mapping normalized game IDs
(lowercase, no surrounding whitespace) to distinct backend credentials of at least
32 bytes. No credentials are supplied by this repository. Missing/empty configuration
leaves the Nakama exchange disabled (401); malformed configuration stops startup.
There is no fallback to `INTERNAL_SERVICE_KEY`, `IDENTITY_ADMIN_KEY`, platform
sessions, Nakama HTTP keys, or a shared cross-game key.

The trusted backend sends its game's credential in `x-nakama-exchange-key`, over
HTTPS, with `game_id`, `nakama_user_id`, and optional `display_name`. The credential
only authorizes its configured game. Treat it as authority to assert any identity
within that game: keep it server-side, out of game exports, logs and source control.
The backend MUST require an authenticated Nakama context and derive the user ID
from `ctx.userId`; never forward a client-selected user ID. This is backend
assertion authentication, not verification of a Nakama player session JWT.
Issued sessions retain the configured `SESSION_ISSUER` and `SESSION_AUDIENCE` and
include `game_id` and `nakama_user_id`. Request bodies cannot override audience or
issuance time. Consumers requiring game isolation must validate `game_id` as well
as the platform audience; this patch does not change downstream authorization.
Public web/magic-link routes and CrazyGames verification are unchanged.

Rollout prerequisites (not performed by this patch):

1. Provision distinct per-game, per-environment credentials through approved secret
   management and configure the gateway's `NAKAMA_EXCHANGE_KEYS_JSON`.
2. Update every backend exchange caller to send `x-nakama-exchange-key` and use
   only authenticated `ctx.userId`. Coordinate caller/configuration rollout before
   enabling exchange; old callers intentionally receive 401 after this patch.
3. Test with controlled staging accounts from a commit merged to `main`, then
   promote that reviewed main revision to production. Never test forged production
   identities. Removal of a game's mapping revokes its ability to exchange;
   existing issued platform sessions remain valid until expiry.

Read-only caller inspection found `LumaRush/backend/nakama/modules/index.js` has
both `rpcPlatformAuthExchange` and `exchangePlatformSession` calling this route
without proof. The RPC currently prefers payload `nakama_user_id` over `ctx.userId`;
that must be corrected before giving this backend an exchange credential.
`LumaRush/backend/nakama/modules/lumarush.js` also exchanges without proof, using
`ctx.userId` and `TPX_PLATFORM_IDENTITY_NAKAMA_AUTH_URL`. The canonical
`Terapixel-Games/ArcadeCore` repository was unavailable (GitHub returned repository
not found), so its `backend/templates/nakama-game-backend` could not be verified;
update/audit the canonical template and all generated backends before rollout.
Caller repositories were not modified.

Source review confirms this route previously minted sessions from supplied IDs,
`main.js` added no caller authentication, and the Cloud Run manifest declares the
identity service public. Actual deployed exposure has not been verified.

Release trigger review: `.github/workflows/cloudrun-deploy.yml` runs on pushes to
`main` (staging), version tags `v*` (production), and manual dispatch. Deploys are
conditional on environment `CLOUDRUN_ENABLED`; live variable values were not
inspected. CI tests and deployment are separate workflows, so deployment does not
wait for the CI workflow. Render deployment is manual. Branch pushes and PRs do
not trigger the checked-in deployment workflows. Tag/manual workflows do not
currently enforce ancestry from main; release operators must select a reviewed
main revision. No merge, tag, workflow dispatch, deployment, or live configuration
change is part of this patch.

### Staging replacement: preserve deployed edge ingress

The staging image identified by digest
`sha256:c872c6454424a39e2b04161812985e2073bfd3c418aad71aac31895f7829d0a6`
contains an ingress guard absent from repository history. The replacement preserves
its recovered implementation: when `EDGE_INGRESS_SECRET` is configured,
`x-terapixel-origin-secret` is required outside health/JWKS and the existing
`/v1/identity/internal/` exemption. Those internal routes still require their admin
key. OPTIONS handling and public web/magic-link behavior through the trusted edge
remain unchanged. Secret comparisons use the recovered constant-time helper.
No runtime secret values were recovered from the image or added to this repository.

This origin proof is distinct from `x-nakama-exchange-key`: backend exchanges must
satisfy both existing ingress policy and the dedicated backend proof. Global player
sessions remain intentional; no consumer game_id rejection is included. Without
approved exchange-key configuration, Nakama exchange remains fail-closed.

Main pushes no longer trigger the all-service Cloud Run deployment workflow.
Existing version-tag/manual entrypoints remain; operators must not dispatch that
workflow for an identity-only release because it deploys every manifest service.
The scoped staging replacement targets only `terapixel-identity-gateway` in
`terapixel-platform-staging`, `us-central1`, from reviewed main, using an image-only
service update preserving existing runtime identity, environment, secret references,
IAM and ingress settings. Record the old revision/digest before any deployment.
