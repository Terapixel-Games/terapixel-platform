# Prepared data-safety stack: local PostgreSQL validation

Validated 2026-10-21, LOCAL ONLY. No publication, remote/main merge, deployment,
cloud credential use, live DB access, host PostgreSQL startup, or security settings
change occurred during this work item. Existing branches/worktrees are preserved.

## Exact source and ancestry

- Tested code commit: `d6871bbda5a3a6a925b4348f0eb64a1819d67596`.
- Dedicated local branch: `review/data-safety-postgres-local`.
- Prepared saves: `728cc043f5fa7bc75f133ac581558da8bfdaac8c`, whose direct parent is
  integrated `90feb4de1ac52070b2caac601e5baf9ab83abb8d`.
- Integrated stack contains wallet `20ffb85` (original `77bb6ac`), file serialization
  `23890b8` (original `501eaa3`), lifecycle `b477c66` (original `6c086b9`), consumption
  `81f65f7` (original `84ebd2b`), and gateway/CI changes.
- Unmerged PR8 harness `6c8982cd87d3d8fed0e7e9a64284c946ff365b88` was cherry-picked
  locally as `c48525a`; its CI conflict retained the pinned actions and Node22
  harness configuration. PR8 was not merged remotely.
- Current main `174e68e264dc14fe2ab4451f7163d07dd606d176` was integrated only into
  this disposable review branch as `9b2cd4d`. README additions were retained; the
  CI conflict retained one setup-node step and harness Node22. Application source
  merged automatically. Main's ingress guard/workflow regressions pass here.
- Paused blanket game-binding `bdab2f7` is not an ancestor; its helper/routes/tests
  are absent. Platform-wide player-token policy remains unchanged.

## Final results (not just harness smoke)

| Pinned runner | Database | Full suite | Separate migration/CRUD check |
|---|---|---|---|
| Node 20.20.2 | PostgreSQL 16.15 | 221 pass / 0 fail / 0 skip | 1 pass / 0 skip |
| Node 22.23.3 | PostgreSQL 16.15 | 221 pass / 0 fail / 0 skip | 1 pass / 0 skip |

Node20 image digest: `2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0`.
Node22: `c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`.
PostgreSQL: `07f75b9a180f8c1feb17354ea9dcc556876d805802412f71b2173ff0c8f0b176`.

Four previously skipped real PostgreSQL tests ran in the full suite:

1. Wallet: trigger failure after transaction-key insert rolls back both key and
   benefit; retry grants once; 20 concurrent identical purchases grant once;
   failed debit keys remain reusable; 20 concurrent spends exhaust funds without
   negative balance and an initially rejected spend succeeds after refill.
   Provider verification is mocked: these are real storage tests, not real payments.
2. Identity: merge-code write failure rolls back consumption; retry/reuse behavior;
   20 concurrent code redeemers produce one success; magic-link write failure
   rolls back and 20 concurrent consumers produce one success.
3. IAP profile merge: injected failure preserves both profiles; 20 repeated merges
   transfer once; a competing writer is excluded by the real table lock and an
   explicit lock-timeout assertion. Late secondary writes remain separate work.
4. Saves: forced same-snapshot readers test first-row and existing-row races,
   retry/remerge preserves both devices' progress; delete-trigger failure rolls
   back destination and source changes; a missing-destination race is held at a
   real row lock, a second connection inserts the destination, and migration
   rolls back/retries against fresh rows preserving both profiles' progress.

The full suite additionally exercises scripted same-client/rollback/release paths,
memory/file serialization and failed persistence recovery, stale snapshot/reused
revision checks, bounded contention, malformed envelope versions and HTTP errors.
Migrations run twice in the synthetic database before tests. Each real-PG suite
creates/drops its own schema. No production provider/webhook or cross-service saga
readiness is implied by these passing results.

## Harness corrections and current-main integration gaps

Original PR8's smoke harness set only DATABASE_URL, while prepared integration
suites intentionally read their own explicit opt-in URLs and accept only loopback.
Commit `63e9708` wires all three exact synthetic URLs through a shared URL validator
and explicit Compose marker. Other remote hosts, altered credentials/URLs and query
or fragment overrides remain rejected; DATABASE_URL is never a fallback. Missing
mandatory test markers or any skip count now fails the runner. It adds a real
save destination-insert race and URL-guard regression.

Current-main compatibility first failed five workflow regressions because the
container allowlist omitted required workflow/script inputs. `9d964bc` includes
only those source inputs and installs Python in the disposable image, not the Mac.
The remaining three mock-CLI failures exposed /tmp's intended noexec mount;
`2eef249` runs fixtures through the interpreter and keeps noexec unchanged.
`d6871bb` adds an explicit pinned Node image selector for the Node20/22 matrix.
No product-store changes were required by observed PostgreSQL failures.

## Isolation, commands and evidence

Use the existing Docker Desktop context explicitly; DOCKER_HOST's stale localhost
endpoint was not changed. Every invocation creates a fresh owned Compose project.
The rendered config was checked for no published ports, no bind/credential mounts,
an internal-only network, a read-only nonroot runner and mandatory PostgreSQL health
dependency. Database files live in tmpfs. Runtime networking has no external egress.
Image build fetches public Debian/npm dependencies; it has no credential mounts.

Commands from this worktree:

```
TEST_DOCKER_CONTEXT=desktop-linux sh tools/test-compose.sh
TEST_NODE_IMAGE='node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0' TEST_DOCKER_CONTEXT=desktop-linux sh tools/test-compose.sh
```

Final Node20 evidence: `reports/compose/run-C7gTHu2H/`.
Final Node22 evidence: `reports/compose/run-wEt5z13X/`.
Initial prepared-stack-only pass (213 + 1, no skips): `run-odPWIgpJ/`.
Current-main diagnostic failures: `run-qSnqX0vs/`, `run-Mk6n0w9M/`.
First combined Node22 pass: `run-Abcsezyj/`.
Evidence is local/ignored, not committed. `cleanup-verification.json` records zero
remaining containers/networks for all six exact owned project labels. No global
prune or unrelated resource cleanup occurred. Cached test images remain available.

## Limits and review gates

This validates PostgreSQL16 on synthetic local data, not deployed Cloud SQL versions,
production permissions/data migrations, process/host crash durability, uncertain
COMMIT acknowledgements or production-scale lock latency. Scripted rollback-failure
and release checks remain scripted. File adapters remain single-process.
Save merging retains its existing maxima/fresher-field policy, not a CRDT or summed
independent counters. Cross-game/cross-service account merge recovery, write fences
and late-secondary redirection remain unimplemented. Included billing lifecycle code
keeps unsupported webhooks disabled; no live signature/provider readiness is claimed.

Review local harness follow-ups and the data patches before any publication.
Nothing in these results authorizes main/staging/production rollout.
