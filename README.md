# terapixel-platform

Shared backend platform repository for reusable services across TeraPixel games.

## Current Production-Ready Services
- `services/identity-gateway`: provider/Nakama identity verification + player session minting and identity linking.
- `services/save-service`: authenticated cloud save sync/merge service.
- `services/feature-flags`: game/profile feature-flag resolution service.
- `services/telemetry-ingest`: authenticated telemetry batch ingest service.
- `services/iap-service`: purchase verification and entitlement source of truth.
- `services/control-plane`: multi-tenant admin API + persistent title/environment/runtime config source of truth.
- `services/player-service`: reusable player profile logic module.

## Quick Start
Requirements:
- Node.js 18+

Run tests:
- `npm test`

Env template:
- copy `.env.example` and set secure values.

Run identity gateway:
- `SESSION_SIGNING_ALG=RS256 SESSION_SIGNING_KEY_ID=tpx-session-v1 SESSION_SIGNING_KEY_PEM="..." npm run start:identity`

Run save service:
- `SESSION_JWKS_URL=http://localhost:8080/.well-known/jwks.json npm run start:save`

Run feature flags service:
- `npm run start:flags`

Run telemetry ingest service:
- `SESSION_JWKS_URL=http://localhost:8080/.well-known/jwks.json npm run start:telemetry`

Run iap service:
- `SESSION_JWKS_URL=http://localhost:8080/.well-known/jwks.json npm run start:iap`

Run control-plane service:
- `DATABASE_URL=... GOOGLE_OAUTH_CLIENT_ID=... npm run start:control-plane`

Run SQL migrations:
- `DATABASE_URL=... npm run db:migrate`

Onboard a title + notify targets (control-plane DB bootstrap):
- `DATABASE_URL=... PLATFORM_CONFIG_ENCRYPTION_KEY=... npm run control-plane:onboard-title -- --help`

Machine onboarding via control-plane API:
- `POST /v1/internal/onboarding/title-registration` with `x-admin-key` (`CONTROL_PLANE_ONBOARDING_KEY`).

Identity gateway also requires:
- `CRAZYGAMES_EXPECTED_AUDIENCE=<your-game-audience>`

Nakama-first auth flow uses:
- `POST /v1/auth/nakama` to mint platform sessions from `nakama_user_id`.
- `POST /v1/identity/link` to merge two Nakama identities into one global player (requires `IDENTITY_ADMIN_KEY`).

## Repository Layout
- `services/` runtime service modules
- `adapters/` provider-specific adapters
- `packages/` shared contracts and utilities
- `infra/` deployment assets/templates
- `ops/` operations docs
- `templates/` per-game backend templates
- `docs/` architecture and onboarding docs

## API Contracts
JSON Schemas live in `packages/api-contracts/schemas`.

## Deploy
- Render fallback path (manual only, decommissioned by default): `.github/workflows/render-deploy.yml`
- Cloud Run full-platform path (manifest-driven): `.github/workflows/cloudrun-deploy.yml`
- Route smoke checks (scheduled + post deploy): `.github/workflows/smoke-check-routes.yml`
- Cloud Run setup/runbook: `docs/cloud-run-deploy.md`
- Idempotent infra bootstrap (Cloud Run + Cloud SQL): `scripts/cloudrun/bootstrap-platform.sh`
- Runtime secret migration (Cloud Run env -> Secret Manager refs): `scripts/cloudrun/migrate-runtime-secrets-to-secret-manager.sh`
- Ops guardrails runbook (alerts + budgets + smoke): `docs/ops-guardrails.md`
- Ops guardrails script: `scripts/cloudrun/configure-ops-guardrails.sh`
- Render decommission/recovery helper: `scripts/render/manage-services.sh`
- Render fallback runbook: `docs/render-fallback.md`

## Notes
- Services expose `/healthz` for liveness.
- HTTP responses include `x-request-id` and `request_id` for traceability.

Portable isolated Docker/PostgreSQL tests: [instructions](infra/testing/README.md).
