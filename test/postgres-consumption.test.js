import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withPostgresTransaction } from "../packages/shared-utils/index.js";
import { InMemoryIdentityStore, PostgresIdentityStore } from "../services/identity-gateway/index.js";
import { PostgresIapStore } from "../services/iap-service/index.js";

// These scripted clients validate SQL and client ownership, not PostgreSQL locks.
function fixture(Store, steps) {
  const releases = [];
  const events = [];
  const client = {
    async query(sql, params) {
      const text = sql.replace(/\s+/g, " ").trim();
      events.push(text);
      const step = steps.shift();
      assert.ok(step, `unexpected SQL: ${text}`);
      assert.match(text, step.sql);
      step.check?.(params);
      if (step.error) throw step.error;
      return { rows: step.rows || [] };
    },
    release(error) { releases.push(error); }
  };
  const pool = {
    async connect() { return client; },
    async query() { throw new Error("transaction escaped to pool.query"); }
  };
  return { store: Store ? new Store({ pool }) : null, pool, steps, releases, events };
}
const begin = { sql: /^BEGIN$/ };
const commit = { sql: /^COMMIT$/ };
const rollback = { sql: /^ROLLBACK$/ };
const codeRow = { primary_profile_id: "primary", created_at: 100, expires_at: 1000, used_at: null };
const codeSelect = { sql: /FROM identity_merge_codes.*LIMIT 1 FOR UPDATE/, rows: [codeRow] };
const edgeLock = { sql: /^LOCK TABLE identity_merges IN SHARE ROW EXCLUSIVE MODE$/ };
const resolve = { sql: /^SELECT primary_profile_id FROM identity_merges/ };
const codeUse = { sql: /^UPDATE identity_merge_codes.*used_at IS NULL.*RETURNING code_hash/, rows: [{ code_hash: "hash" }] };
const mergeEdge = { sql: /^INSERT INTO identity_merges/ };
const magicRow = { email: "player@example.test", profile_id: "profile", game_id: "game", expires_at: 1000, used_at: null };
const magicSelect = { sql: /FROM identity_magic_links.*LIMIT 1 FOR UPDATE/, rows: [magicRow] };
const magicUse = { sql: /^UPDATE identity_magic_links.*used_at IS NULL.*RETURNING token_hash/, rows: [{ token_hash: "hash" }] };
const coinLock = { sql: /^LOCK TABLE iap_coin_balances, iap_subscriptions IN SHARE ROW EXCLUSIVE MODE$/ };
const coinRead = { sql: /^SELECT game_id, balance FROM iap_coin_balances/, rows: [{ game_id: "game", balance: 50 }] };
const coinCredit = { sql: /^INSERT INTO iap_coin_balances/, check: (params) => assert.deepEqual(params, ["primary", "game", 50]) };
const coinClear = { sql: /^UPDATE iap_coin_balances SET balance = 0/ };
const subRead = { sql: /^SELECT provider, external_subscription_id, status, active, expires_at FROM iap_subscriptions/ };
const subWrite = { sql: /^INSERT INTO iap_subscriptions/ };

function assertFinished(f) {
  assert.equal(f.steps.length, 0);
  assert.deepEqual(f.releases, [undefined]);
}

describe("checked-out PostgreSQL transaction ownership (scripted clients)", () => {
  it("commits and releases on success", async () => {
    const f = fixture(null, [begin, { sql: /^SELECT 1$/ }, commit]);
    assert.equal(await withPostgresTransaction(f.pool, async (client) => { await client.query("SELECT 1"); return "result"; }), "result");
    assertFinished(f);
  });

  for (const stage of ["begin", "operation", "commit"]) {
    it(`preserves ${stage} failure and releases`, async () => {
      const error = new Error(`${stage} failure`);
      const sequence = stage === "begin" ? [{ ...begin, error }] : stage === "commit" ? [begin, { ...commit, error }, rollback] : [begin, rollback];
      const f = fixture(null, sequence);
      await assert.rejects(withPostgresTransaction(f.pool, async () => { if (stage === "operation") throw error; }), (actual) => actual === error);
      assert.equal(f.steps.length, 0);
      assert.deepEqual(f.releases, [stage === "begin" ? error : undefined]);
    });
  }

  it("preserves original error and discards client if rollback fails", async () => {
    const error = new Error("original");
    const rollbackError = new Error("connection lost");
    const f = fixture(null, [begin, { ...rollback, error: rollbackError }]);
    await assert.rejects(withPostgresTransaction(f.pool, async () => { throw error; }), (actual) => actual === error);
    assert.deepEqual(f.releases, [rollbackError]);
  });

  it("does not release an unacquired client", async () => {
    const error = new Error("pool unavailable");
    await assert.rejects(withPostgresTransaction({ connect: async () => { throw error; } }, () => {}), (actual) => actual === error);
  });
});

describe("Postgres identity consumption (scripted clients)", () => {
  it("locks a merge code and resolves canonical IDs on the transaction client", async () => {
    const f = fixture(PostgresIdentityStore, [begin, codeSelect, edgeLock,
      { ...resolve, rows: [{ primary_profile_id: "secondary-root" }] }, resolve,
      { ...resolve, rows: [{ primary_profile_id: "primary-root" }] }, resolve,
      { ...codeUse, check(params) { assert.equal(params[2], "secondary-root"); } },
      { ...mergeEdge, check(params) { assert.deepEqual(params, ["secondary-root", "primary-root", 200]); } }, commit]);
    assert.deepEqual(await f.store.redeemMergeCode("secondary", "test-code", { nowSeconds: 200 }), { primaryProfileId: "primary-root", secondaryProfileId: "secondary-root", mergedAt: 200 });
    assertFinished(f);
  });

  it("consumes a public magic link without changing its response fields", async () => {
    const f = fixture(PostgresIdentityStore, [begin, magicSelect, magicUse, commit]);
    assert.deepEqual(await f.store.consumeMagicLinkToken("", "test-token", { nowSeconds: 200 }), { email: "player@example.test", profileId: "profile", gameId: "game", usedByProfileId: "profile", usedAt: 200 });
    assertFinished(f);
  });

  for (const [label, method, select, row] of [
    ["merge code", "redeemMergeCode", codeSelect, codeRow],
    ["magic link token", "consumeMagicLinkToken", magicSelect, magicRow]
  ]) {
    for (const [reason, replacement] of [["not found", null], ["already used", { ...row, used_at: 0 }], ["expired", { ...row, expires_at: 199 }]]) {
      it(`rejects ${reason} ${label} and rolls back/releases`, async () => {
        const f = fixture(PostgresIdentityStore, [begin, { ...select, rows: replacement ? [replacement] : [] }, rollback]);
        await assert.rejects(f.store[method]("secondary", "test-value", { nowSeconds: 200 }), new RegExp(reason));
        assertFinished(f);
      });
    }
  }

  it("self merge is rejected without consuming the code", async () => {
    const f = fixture(PostgresIdentityStore, [begin, codeSelect, edgeLock, resolve, resolve, rollback]);
    await assert.rejects(f.store.redeemMergeCode("primary", "code", { nowSeconds: 200 }), /itself/);
    assertFinished(f);
  });

  it("empty profile validation rolls back a magic link before consumption", async () => {
    const f = fixture(PostgresIdentityStore, [begin, { ...magicSelect, rows: [{ ...magicRow, profile_id: "" }] }, rollback]);
    await assert.rejects(f.store.consumeMagicLinkToken("", "token", { nowSeconds: 200 }), /missing profile/);
    assertFinished(f);
  });

  it("defensively rejects a lost conditional consume", async () => {
    const f = fixture(PostgresIdentityStore, [begin, magicSelect, { ...magicUse, rows: [] }, rollback]);
    await assert.rejects(f.store.consumeMagicLinkToken("", "token", { nowSeconds: 200 }), /already used/);
    assertFinished(f);
  });

  it("rolls back code consumption if writing the merge edge fails", async () => {
    const error = new Error("edge write failed");
    const f = fixture(PostgresIdentityStore, [begin, codeSelect, edgeLock, resolve, resolve, codeUse, { ...mergeEdge, error }, rollback]);
    await assert.rejects(f.store.redeemMergeCode("secondary", "code", { nowSeconds: 200 }), (actual) => actual === error);
    assertFinished(f);
  });

  it("rolls back token update failure", async () => {
    const error = new Error("consume failed");
    const f = fixture(PostgresIdentityStore, [begin, magicSelect, { ...magicUse, error }, rollback]);
    await assert.rejects(f.store.consumeMagicLinkToken("", "token", { nowSeconds: 200 }), (actual) => actual === error);
    assertFinished(f);
  });
});

describe("Postgres IAP profile merge (scripted clients)", () => {
  it("locks writers and keeps transfer and all subscription helpers on one client", async () => {
    const f = fixture(PostgresIapStore, [begin, coinLock, coinRead, coinCredit, coinClear, subRead,
      { ...subRead, rows: [{ provider: "apple", active: true, status: "active", expires_at: "2030-01-01T00:00:00Z" }] },
      { ...subWrite, check(params) { assert.equal(params[0], "primary"); assert.equal(params[4], true); } },
      { ...subWrite, check(params) { assert.equal(params[0], "secondary"); assert.equal(params[3], "merged"); assert.equal(params[4], false); } }, commit]);
    assert.deepEqual(await f.store.mergeProfiles("primary", "secondary"), { merged: true });
    assertFinished(f);
  });

  for (const stage of ["credit", "clear", "subscription"]) {
    it(`rolls back complete merge on ${stage} failure`, async () => {
      const error = new Error(`${stage} failed`);
      const prefix = [begin, coinLock, coinRead];
      const steps = stage === "credit" ? [...prefix, { ...coinCredit, error }] : stage === "clear" ? [...prefix, coinCredit, { ...coinClear, error }] : [...prefix, coinCredit, coinClear, subRead, subRead, { ...subWrite, error }];
      const f = fixture(PostgresIapStore, [...steps, rollback]);
      await assert.rejects(f.store.mergeProfiles("primary", "secondary"), (actual) => actual === error);
      assertFinished(f);
    });
  }

  it("does not connect for an invalid/self pair", async () => {
    const f = fixture(PostgresIapStore, []);
    assert.deepEqual(await f.store.mergeProfiles("primary", "primary"), { merged: false });
    assert.deepEqual(await f.store.mergeProfiles("", "secondary"), { merged: false });
    assert.deepEqual(f.releases, []);
  });
});

describe("in-memory identity single-use parity", () => {
  it("allows exactly one concurrent merge-code redemption", async () => {
    const store = new InMemoryIdentityStore();
    const { code } = await store.createMergeCode("primary", { nowSeconds: 100 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => store.redeemMergeCode(`secondary-${i}`, code, { nowSeconds: 200 })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && /already used/.test(result.reason.message)).length, 19);
  });

  it("allows exactly one concurrent public magic-link consumption", async () => {
    const store = new InMemoryIdentityStore();
    const { token } = await store.createMagicLinkToken("p@example.test", "profile", { nowSeconds: 100 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => store.consumeMagicLinkToken("", token, { nowSeconds: 200 })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && /already used/.test(result.reason.message)).length, 19);
  });

  it("rejects token reuse even when a test clock records usedAt zero", async () => {
    const store = new InMemoryIdentityStore();
    const { token } = await store.createMagicLinkToken("p@example.test", "profile", { nowSeconds: 0 });
    await store.consumeMagicLinkToken("", token, { nowSeconds: 0 });
    await assert.rejects(store.consumeMagicLinkToken("", token, { nowSeconds: 0 }), /already used/);
  });

  it("rejects code reuse even when a test clock records usedAt zero", async () => {
    const store = new InMemoryIdentityStore();
    const { code } = await store.createMergeCode("primary", { nowSeconds: 0 });
    await store.redeemMergeCode("secondary", code, { nowSeconds: 0 });
    await assert.rejects(store.redeemMergeCode("another", code, { nowSeconds: 0 }), /already used/);
  });

  it("does not consume a token on missing-profile validation failure", async () => {
    const store = new InMemoryIdentityStore();
    const { token } = await store.createMagicLinkToken("p@example.test", "", { nowSeconds: 100 });
    await assert.rejects(store.consumeMagicLinkToken("", token, { nowSeconds: 200 }), /missing profile/);
    assert.equal((await store.consumeMagicLinkToken("profile", token, { nowSeconds: 200 })).usedByProfileId, "profile");
  });

  it("does not consume a merge code on invalid-pair validation failure", async () => {
    const store = new InMemoryIdentityStore();
    const { code } = await store.createMergeCode("primary", { nowSeconds: 100 });
    await assert.rejects(store.redeemMergeCode("", code, { nowSeconds: 200 }), /invalid merge pair/);
    assert.equal((await store.redeemMergeCode("secondary", code, { nowSeconds: 200 })).primaryProfileId, "primary");
  });
});
