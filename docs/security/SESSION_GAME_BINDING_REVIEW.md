# Local session game binding review — 2026-10-21

This patch is based on gateway PR7 head 7d8e2af, independently of local wallet,
billing, saves and merge-saga work. It changes HTTP authorization only; no provider,
store, credential or deployment behavior is changed. Nothing has been published.

## Implemented compatibility boundary

When a verified session contains game_id, that claim must be a nonempty canonical
lowercase string and exactly equal the game ID passed to the service. Present null,
number, array, object, blank, whitespace or mixed-case claims fail closed. All
mismatches return 403 game_scope_mismatch before service/store/provider work.

Covered routes: save sync, IAP purchase verification and coin adjustment, flags
reads (explicit or inferred profile), and telemetry (required or optional auth).
IAP internal admin routes are unchanged. Anonymous public flags/optional telemetry
remain available. Existing audience/signature/expiry checks still run first.
Flags' existing invalid-optional-session anonymous fallback and telemetry's existing
invalid-supplied-session rejection are unchanged.

An absent game_id is intentionally still accepted. This preserves existing
platform-wide web/magic-link sessions and legacy clients, but is not a new proof
of web origin: existing unscoped Nakama sessions also remain accepted until expiry.
A strict legacy cutoff, separate web-vs-game session type or revocation policy needs
an explicit compatibility decision and separate rollout. The gateway already signs
new Nakama sessions with game_id. This patch does not remove claims from tokens.

GET /v1/iap/entitlements remains account-wide, including per-game coin entries;
there is no explicit game request parameter in its contract. Filtering it, changing
subscription visibility, and app/web-wide access policy are unresolved and must not
be silently inferred. A regression records the unchanged behavior, not approval of
that final product policy. Do not claim complete account/game data isolation yet.
Public magic-link routes are untouched and existing regression tests remain required.

## Wiring review and verification blockers

LumaRush local follow-up 3ab2993 adds TPX_NAKAMA_EXCHANGE_KEY via secretKeyRef with
explicit resource name and numeric version metadata; it neither supplies credential
values nor creates resources. Its 19 backend tests pass, including missing/unsafe
metadata rejection before cloud authentication. Runtime.env forwarding and both
active/alternative exchange paths were already covered by caller tests. Remote
PR13 remains bca6930. Staging/prod service defaults are still identical and need
explicit target inspection before any release.

Read-only verification attempts:

- GitHub connector identifies as TeraPixelGames. GET platform main branch protection
  returned 403 Resource not accessible by integration. No alternative account or
  protection endpoint was used to bypass that denial. PR7 previously reports blocked
  while its reported test check passes; exact required-review/protection cause remains
  unknown. An authorized maintainer can provide the merge-box reason without altering
  protections. Do not treat green checks as permission to merge.
- gcloud auth list failed inside the sandbox while trying to write protected SDK
  logs/credential DB. Read-only core configuration metadata then showed account
  john@stara.co and project ollama-501617. Cloud inspection stopped: no GCP request,
  token/private key reading, account switch or credential/configuration change.
  These are not verified TeraPixel targets. Never use them for this work.

Actual staging project IDs, region, service names, runtime account emails, secret
resource/version metadata and active revision/traffic remain unverified. A verified
TeraPixel cloud account must be explicitly selected/approved before read-only
inspection. GitHub TeraPixel identity does not confer GCP authority. Do not request
credential provisioning with guessed project names.

## Next bounded steps

1. Review this local patch and unresolved entitlement/unscoped-session policy.
2. Ask an authorized maintainer to explain PR7's blocked merge condition; no bypass.
3. Request explicit identification of the existing TeraPixel GCP account/project(s),
   then read-only service/revision/traffic, runtime-account, secret-reference metadata
   and IAM-policy inspection. Do not read secret payloads or alter active global auth.
4. Once exact targets are recorded, request staging-only approval for named secret
   creation/version addition, per-secret runtime accessor bindings, environment
   metadata configuration and a narrowly scoped release from reviewed main revisions.
   Treat publication, merges, configuration/IAM and deployment as distinct actions.
5. Production requires separate approval after controlled staging acceptance. Retain
   authenticated gateway on rollback; disable exchanges rather than restoring the
   vulnerable proof-free revision. Follow main -> staging -> production.

Platform main can auto-deploy staging and its workflow deploys all manifest services;
LumaRush main can deploy Nakama/Pages. Manual/tag releases do not enforce main ancestry.
Live gates/external hosting hooks are unverified; platform deployment action pins
remain a readiness concern under the previously observed full-SHA organization rule.
PostgreSQL startup approval remains pending; none is needed for this mock HTTP suite.
