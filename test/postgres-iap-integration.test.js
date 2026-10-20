import { it } from "node:test";
import assert from "node:assert/strict";
import { createIapService, PostgresIapStore } from "../services/iap-service/index.js";

// Opt-in only: never use DATABASE_URL or a remote host. Requires an existing
// local PostgreSQL server and npm-installed pg. Creates/drops one isolated schema.
it("real local PostgreSQL: atomic grants, failed-debit retries and concurrent spends", {
  skip: !process.env.IAP_TEST_LOCAL_DATABASE_URL,
  timeout: 30_000
}, async () => {
  const url = new URL(process.env.IAP_TEST_LOCAL_DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "integration DB must be loopback");
  assert.equal(url.search, "", "connection-string query overrides are not allowed");
  const { default: pg } = await import("pg");
  const schema = `iap_atomic_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000 });
  let pool;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    pool = new pg.Pool({ connectionString: url.toString(), options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: 3000 });
    const store = new PostgresIapStore({ pool });
    await store.init();
    const service = createIapService({ store, providerRegistry: {
      async verifyPurchase({ provider, catalogEntry, payload }) {
        return { provider, externalTransactionId: payload.transaction_id, type: "consumable", gameId: catalogEntry.gameId, coinsDelta: catalogEntry.coins };
      }
    } });
    const buy = (id, profileId = "buyer") => service.verifyPurchase({ profileId, provider: "google", productId: "coins_500_lumarush", exportTarget: "android", payload: { transaction_id: id } });
    const adjust = (delta, key) => service.adjustCoins({ profileId: "spender", gameId: "lumarush", delta, idempotencyKey: key });

    // Raise after the dedupe INSERT, during the grant, using a real DB trigger.
    await pool.query(`CREATE FUNCTION reject_grant() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected wallet grant failure'; END $$`);
    await pool.query(`CREATE TRIGGER reject_grant BEFORE UPDATE ON iap_coin_balances
      FOR EACH ROW EXECUTE FUNCTION reject_grant()`);
    await assert.rejects(buy("faulted-purchase", "faulted-buyer"), /injected wallet grant failure/);
    assert.deepEqual(await store.getCoins("faulted-buyer"), {});
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM iap_transactions")).rows[0].n, 0);
    await pool.query("DROP TRIGGER reject_grant ON iap_coin_balances");
    assert.equal((await buy("faulted-purchase", "faulted-buyer")).deduplicated, false);
    assert.equal((await buy("faulted-purchase", "faulted-buyer")).deduplicated, true);
    assert.equal((await store.getCoins("faulted-buyer")).lumarush.balance, 500);

    const purchases = await Promise.all(Array.from({ length: 20 }, () => buy("same-purchase")));
    assert.equal(purchases.filter((result) => !result.deduplicated).length, 1);
    assert.equal((await store.getCoins("buyer")).lumarush.balance, 500);

    await assert.rejects(adjust(-10, "initially-unfunded"), /insufficient coins/);
    await adjust(100, "fund");
    assert.equal((await adjust(-10, "initially-unfunded")).deduplicated, false);
    assert.equal((await adjust(-10, "initially-unfunded")).deduplicated, true);
    const spends = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => adjust(-10, `spend-${i}`)));
    assert.equal(spends.filter((result) => result.status === "fulfilled").length, 9);
    assert.equal(spends.filter((result) => result.status === "rejected" && /insufficient coins/.test(result.reason.message)).length, 11);
    assert.equal((await store.getCoins("spender")).lumarush.balance, 0);
    const failed = spends.findIndex((result) => result.status === "rejected");
    await adjust(10, "refill");
    assert.equal((await adjust(-10, `spend-${failed}`)).deduplicated, false);
    assert.equal((await store.getCoins("spender")).lumarush.balance, 0);
  } finally {
    if (pool) await pool.end();
    try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
});
