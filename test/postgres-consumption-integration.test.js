import { it } from "node:test";
import assert from "node:assert/strict";
import { PostgresIdentityStore } from "../services/identity-gateway/index.js";
import { PostgresIapStore } from "../services/iap-service/index.js";

// Requires an explicitly supplied already-running local DB. Never DATABASE_URL.
const testOptions = { skip: !process.env.CONSUMPTION_TEST_LOCAL_DATABASE_URL, timeout: 30_000 };
let schemaSequence = 0;
async function withDatabase(run) {
  const url = new URL(process.env.CONSUMPTION_TEST_LOCAL_DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "database must be loopback");
  assert.equal(url.search, "", "connection-string overrides are forbidden");
  const { default: pg } = await import("pg");
  const schema = `consumption_test_${process.pid}_${Date.now()}_${schemaSequence++}`;
  const admin = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000 });
  let pool, created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    pool = new pg.Pool({ connectionString: url.toString(), options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: 3000 });
    await run(pool);
  } finally {
    if (pool) await pool.end();
    try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
}

it("real local PostgreSQL: one-time identity consumption, rollback/retry and concurrency", testOptions, () => withDatabase(async (pool) => {
  const store = new PostgresIdentityStore({ pool });
  await store.init();
  const now = Math.floor(Date.now() / 1000);
  const code = await store.createMergeCode("primary", { nowSeconds: now });
  await pool.query(`CREATE FUNCTION reject_edge() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected edge failure'; END $$`);
  await pool.query("CREATE TRIGGER reject_edge BEFORE INSERT ON identity_merges FOR EACH ROW EXECUTE FUNCTION reject_edge()");
  await assert.rejects(store.redeemMergeCode("secondary", code.code, { nowSeconds: now }), /injected edge failure/);
  assert.equal((await pool.query("SELECT used_at FROM identity_merge_codes")).rows[0].used_at, null);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM identity_merges")).rows[0].n, 0);
  await pool.query("DROP TRIGGER reject_edge ON identity_merges");
  assert.equal((await store.redeemMergeCode("secondary", code.code, { nowSeconds: now })).primaryProfileId, "primary");
  await assert.rejects(store.redeemMergeCode("other", code.code, { nowSeconds: now }), /already used/);

  const concurrentCode = await store.createMergeCode("other-primary", { nowSeconds: now });
  const codes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => store.redeemMergeCode(`other-secondary-${i}`, concurrentCode.code, { nowSeconds: now })));
  assert.equal(codes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(codes.filter((result) => result.status === "rejected" && /already used/.test(result.reason.message)).length, 19);

  const magic = await store.createMagicLinkToken("player@example.test", "profile", { nowSeconds: now, gameId: "game" });
  await pool.query(`CREATE FUNCTION reject_magic() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected magic failure'; END $$`);
  await pool.query("CREATE TRIGGER reject_magic BEFORE UPDATE ON identity_magic_links FOR EACH ROW EXECUTE FUNCTION reject_magic()");
  await assert.rejects(store.consumeMagicLinkToken("", magic.token, { nowSeconds: now }), /injected magic failure/);
  assert.equal((await pool.query("SELECT used_at FROM identity_magic_links")).rows[0].used_at, null);
  await pool.query("DROP TRIGGER reject_magic ON identity_magic_links");
  const tokens = await Promise.allSettled(Array.from({ length: 20 }, () => store.consumeMagicLinkToken("", magic.token, { nowSeconds: now })));
  assert.equal(tokens.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(tokens.filter((result) => result.status === "rejected" && /already used/.test(result.reason.message)).length, 19);
  const result = tokens.find((item) => item.status === "fulfilled").value;
  assert.deepEqual(result, { email: "player@example.test", profileId: "profile", gameId: "game", usedByProfileId: "profile", usedAt: now });
}));

it("real local PostgreSQL: IAP merge rollback, repeated merges and writer exclusion", testOptions, () => withDatabase(async (pool) => {
  const store = new PostgresIapStore({ pool });
  await store.init();
  await store.addCoins("primary", "game", 10);
  await store.addCoins("secondary", "game", 50);
  await store.upsertSubscription("secondary", { provider: "apple", active: true, status: "active", expiresAt: 1_900_000_000 });
  await pool.query(`CREATE FUNCTION reject_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected subscription failure'; END $$`);
  await pool.query("CREATE TRIGGER reject_subscription BEFORE INSERT OR UPDATE ON iap_subscriptions FOR EACH ROW EXECUTE FUNCTION reject_subscription()");
  await assert.rejects(store.mergeProfiles("primary", "secondary"), /injected subscription failure/);
  assert.equal((await store.getCoins("primary")).game.balance, 10);
  assert.equal((await store.getCoins("secondary")).game.balance, 50);
  assert.equal((await store.getSubscription("secondary")).active, true);
  await pool.query("DROP TRIGGER reject_subscription ON iap_subscriptions");
  const results = await Promise.all(Array.from({ length: 20 }, () => store.mergeProfiles("primary", "secondary")));
  assert.ok(results.every((result) => result.merged));
  assert.equal((await store.getCoins("primary")).game.balance, 60);
  assert.equal((await store.getCoins("secondary")).game.balance, 0);
  assert.equal((await store.getSubscription("primary")).active, true);
  assert.equal((await store.getSubscription("secondary")).status, "merged");

  // Pause a merge immediately after its real table lock. A separate ordinary
  // UPDATE must time out instead of changing a wallet during the merge.
  let entered, resume;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  const paused = new PostgresIapStore({ pool: {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          const result = await client.query(sql, params);
          if (sql.startsWith("LOCK TABLE iap_coin_balances")) { entered(); await gate; }
          return result;
        },
        release: client.release.bind(client)
      };
    }
  } });
  const merge = paused.mergeProfiles("primary", "secondary");
  await started;
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout = '100ms'");
    await assert.rejects(writer.query("UPDATE iap_coin_balances SET balance = balance + 1 WHERE profile_id = 'secondary'"), /lock timeout/);
  } finally {
    try { await writer.query("ROLLBACK"); }
    finally { writer.release(); resume(); }
  }
  await merge;
  await store.addCoins("secondary", "game", 1);
  assert.equal((await store.getCoins("secondary")).game.balance, 1);
  // Late writes are preserved, not redirected by this local-store patch.
}));
