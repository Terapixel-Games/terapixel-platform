# Portable TeraPixel platform tests

From the repository root, with an already installed/running Docker Engine and
Docker Compose v2:

```sh
sh tools/test-compose.sh
```

On Docker Desktop when a stale DOCKER_HOST overrides the default endpoint:

```sh
TEST_DOCKER_CONTEXT=desktop-linux sh tools/test-compose.sh
```

The script works from any directory and creates a random `terapixel-test-run-*`
Compose project for each invocation. Do not supply your application `.env` or
production secrets. Compose explicitly uses `/dev/null` as its env file. The
runner receives only fixed synthetic DB credentials and NODE_ENV=test. Images
contain an allowlisted source tree, tests, and lockfile dependencies; no host
source, home, Docker socket, or credential mounts are used. `npm ci` disables
lifecycle scripts, funding and audit calls. Registry/package downloads are needed
at build time; test containers run on an internal network with no host ports.
PostgreSQL data lives in tmpfs and vanishes with the container.

Workflow: build immutable runner -> PostgreSQL health readiness -> mandatory SQL
preflight -> apply migrations twice (idempotency) -> real PostgreSQL save CRUD and
game-isolation test -> existing `npm test`. The required PG check deliberately
fails on missing/unexpected URL, missing dependency, unavailable DB, SQL errors,
or assertions. It never skips. It accepts only the Compose service hostname and
synthetic database. It uses a dedicated synthetic save table; no production data.
Existing `npm ci && npm test` stays usable natively on Node >=18, without Docker
or PostgreSQL. The container workflow pins supported Node 22 and PostgreSQL 16;
the repository does not currently pin its production PostgreSQL major version.
This is a test baseline, not a production-runtime claim.

Each run records build, Compose, service and cleanup logs plus resolved config and
project name under `reports/compose/run-*` (gitignored). The command returns the
runner's failure exit status; build/readiness failures also return nonzero.
EXIT/INT/TERM handlers collect logs then run project-scoped `down --volumes
--remove-orphans`; cleanup failure also causes failure. SIGKILL or daemon loss
cannot guarantee automatic cleanup: read project.txt and run this exact command
with that recorded project (and the same Docker context):

```sh
docker compose --env-file /dev/null -p RECORDED_PROJECT -f compose.test.yaml down --volumes --remove-orphans
```

Never run a global prune. Downloaded official images, project build images and
build cache remain reusable; no containers or networks should remain after normal
completion. Logs are local synthetic test evidence; remove their run directory
when no longer needed.

Both image references use immutable **multiarchitecture index digests**. Registry
manifests verified on 2026-10-21 include linux/amd64 and linux/arm64/v8:

- `node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`
- `postgres:16-bookworm@sha256:07f75b9a180f8c1feb17354ea9dcc556876d805802412f71b2173ff0c8f0b176`

To refresh, inspect official Docker Library manifests using `docker buildx
imagetools inspect IMAGE`, verify both architectures, replace the index digest,
and rerun tests. A manifest entry proves availability, not execution on that CPU.
See VALIDATION.md for actual execution evidence.

The optional `container-tests.yml` runs on relevant pull requests and manual dispatch, with read-only repository
permissions, a full-SHA checkout action with persisted credentials disabled, no
secrets, publishing or deployment. Existing deploy
workflows are outside this change and do not match a test branch push or PR.
Publication and CI execution were separately authorized after local validation.

This harness is based on origin/main bfa62903fd6044727528038148a2b774ebd2ef55.
Local integration/revision-safe backend patches were not incorporated. This
checks the mainline API and does not claim concurrency fixes from those branches.
