# Targeted data-safety staging release

The manual `Data Safety Staging` workflow accepts only main, the fixed staging
project/region and existing GitHub OIDC deployment account. It builds only
identity-gateway, save-service and iap-service, recording immutable image digests
and main source SHA. Required Docker PostgreSQL regressions precede deployment.
There is no push/merge deployment trigger and no production target.

Before rollout, the existing save/IAP DATABASE_URL destinations were parsed only
in memory: both identify `/cloudsql/terapixel-platform-staging:us-central1:terapixel-platform-staging`,
database `terapixel_platform`. Credentials were neither displayed nor persisted.
The user approved disposing of existing instance-local staging save/wallet/purchase
test state and enabling SAVE_STORE_TYPE=postgres and IAP_STORE_TYPE=postgres.
The workflow retains existing DATABASE_URL secret references and changes no
credentials, IAM, session policy, ingress or other runtime configuration.
No new schema migration is required: store initialization uses the existing
idempotent schema definitions, unchanged by the data-safety patch.

All three candidate revisions must be Ready, use the expected digest and preserve
runtime/security metadata and IAM before any receives traffic. Save/IAP Ready
also requires their PostgreSQL pool and store initialization to complete before
listening. Only the two approved store flags may differ. Gateway keeps its exact
ingress guard; public JWKS and denied unguarded web-session behavior are checked.
A pre-existing healthz 404 is recorded as an access/frontend baseline, never
reported as successful application health. Authenticated data-path checks require
an existing legitimate staging session; the workflow does not mint player
sessions, read signing/internal secrets, or contact purchase providers.

Each previous serving revision is recorded before changes. Recovery can route
traffic to the recorded revision using the same fixed staging project/region and
authorized deployment identity, with separate inspection of its store mode.
Returning to an old memory-mode revision does not recover discarded instance-local
test state, and hides PostgreSQL data from that revision. No database data is
deleted by deployment or rollback. Partial traffic promotion is reported as a
failed workflow; inspect actual per-service traffic before fixing forward or
performing an authorized rollback. No automatic destructive recovery is attempted.
