# Local validation, 2026-10-21

Isolated clone: `platform-test-infra`, branch `test/docker-compose-local`, based
only on origin/main `bfa62903fd6044727528038148a2b774ebd2ef55`. No backend
patches copied; other task worktrees were read only. No push, PR, CI dispatch,
merge, deployment, new software installation or Docker configuration change.

Executed:

```sh
TEST_DOCKER_CONTEXT=desktop-linux sh tools/test-compose.sh
```

Docker Desktop 4.48.0 / Engine 28.5.1, Linux AMD64 containers. Actual runtime:
Node v22.23.3, npm 10.9.9, PostgreSQL 16.15. Runner completed with exit 0:

- SQL preflight authenticated to the synthetic service database.
- Both migrations applied successfully, then reran successfully as already applied.
- Real PostgreSQL CRUD, update, game isolation, list and delete: 1 passed, 0 skipped.
- Existing unit/HTTP suite: 89 passed, 0 failed, 0 skipped.
- Cleanup removed both containers and the project network. Subsequent project-label
  container and network listings were empty.

Evidence: `reports/compose/run-6jrmdJif/{build,up,containers,cleanup}.log`.
The first attempt used the inherited unreachable `tcp://localhost:4243` endpoint
and exited 1 before creating resources; its cleanup also reported unreachable
Docker. Selecting the existing Desktop context resolved this without changing
Docker settings. That first project's container listing was empty on Desktop.

Negative check: separate project `terapixel-test-negative-20261021`, using
`compose run --rm --no-deps -e DATABASE_URL= runner node
infra/testing/postgres-check.mjs --preflight`, exited 1 with the expected assertion
`Use the isolated Compose test database only`. Its temporary container was
removed, project down removed its network, and follow-up listings were empty.

Official registry index manifests were inspected using `docker buildx imagetools
inspect`. Both pinned indices include linux/amd64 and linux/arm64/v8. ARM64 was
not executed. No native test run: host PATH resolves to unsupported Node v13.11.0;
no host runtime was installed or changed. Native `npm test` remains unchanged.

Limitations: this is mainline coverage, not validation of unmerged backend fixes.
The local integration branch's PG consumption/IAP tests require loopback and
currently skip when their dedicated variables are absent; they were inspected
only, and are not in this mainline harness. Future integration must deliberately
adapt that loopback guard to the isolated Compose service (or a shared container
network namespace), set their dedicated URLs, and require zero skips. Do not
silently assume this mainline run validated those concurrency/transaction fixes.

Downloaded images and build cache remain; owned containers and networks do not.
Only the manual-dispatch test workflow was added. Existing deployment workflows
were untouched; no workflow has run from these local changes.
