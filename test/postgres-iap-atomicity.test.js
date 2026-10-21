import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PostgresIapStore } from "../services/iap-service/index.js";

// Scripted client tests validate SQL/control flow, not real PostgreSQL locking.
function scriptedStore(steps, { connectError } = {}) {
  const events = [];
  const releases = [];
  const client = {
    async query(sql, params) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      events.push(normalized);
      const step = steps.shift();
      assert.ok(step, `unexpected SQL: ${normalized}`);
      assert.match(normalized, step.sql);
      step.check?.(params, normalized);
      if (step.error) throw step.error;
      return { rows: step.rows || [] };
    },
    release(error) { releases.push(error); }
  };
  const pool = {
    async query() { throw new Error("pool.query used inside transaction"); },
    async connect() { if (connectError) throw connectError; return client; }
  };
  return { store: new PostgresIapStore({ pool }), events, releases, steps };
}
const record = { profileId: "player", type: "consumable", productId: "coins" };
const effect = { coins: { gameId: "lumarush", delta: 50 } };
const insert = { sql: /INSERT INTO iap_transactions/, rows: [{ raw: record }] };
const wallet = { sql: /INSERT INTO iap_coin_balances/ };
const update = { sql: /UPDATE iap_coin_balances.*balance::bigint \+ \$3::bigint >= 0.*RETURNING balance/, rows: [{ balance: 50 }] };
const begin = { sql: /^BEGIN$/ };
const commit = { sql: /^COMMIT$/ };
const rollback = { sql: /^ROLLBACK$/ };

describe("Postgres IAP pinned-client transactions (mocked)", () => {
  it("inserts dedupe and grants on one client before commit/release", async () => {
    const fixture = scriptedStore([begin, insert, wallet, { ...update, check(params) { assert.deepEqual(params, ["player", "lumarush", 50]); } }, commit]);
    assert.equal((await fixture.store.applyTransaction("google", "tx", record, effect)).isNew, true);
    assert.deepEqual(fixture.releases, [undefined]);
    assert.equal(fixture.steps.length, 0);
  });

  it("deduplicated retry reads existing record on pinned client and skips grant", async () => {
    const fixture = scriptedStore([begin, { sql: /INSERT INTO iap_transactions/ }, { sql: /SELECT raw FROM iap_transactions/, rows: [{ raw: record }] }, commit]);
    const result = await fixture.store.applyTransaction("google", "tx", record, effect);
    assert.equal(result.isNew, false);
    assert.deepEqual(result.record, record);
    assert.equal(fixture.steps.length, 0);
    assert.deepEqual(fixture.releases, [undefined]);
  });

  it("insufficient debit rolls back its inserted success key and releases", async () => {
    const fixture = scriptedStore([begin, insert, wallet, { ...update, rows: [] }, rollback]);
    await assert.rejects(fixture.store.applyTransaction("internal_coin_adjust", "spend", record, { coins: { gameId: "lumarush", delta: -60 } }), /insufficient coins/);
    assert.equal(fixture.steps.length, 0);
    assert.deepEqual(fixture.releases, [undefined]);
  });

  for (const stage of ["dedupe", "wallet", "grant", "commit"]) {
    it(`rolls back/releases on ${stage} failure`, async () => {
      const failure = new Error(`${stage} failure`);
      const sequence = [begin, insert, wallet, update, commit];
      const index = { dedupe: 1, wallet: 2, grant: 3, commit: 4 }[stage];
      const steps = sequence.slice(0, index + 1).map((step, i) => i === index ? { ...step, error: failure } : step);
      const fixture = scriptedStore([...steps, rollback]);
      await assert.rejects(fixture.store.applyTransaction("google", "tx", record, effect), (error) => error === failure);
      assert.equal(fixture.steps.length, 0);
      assert.deepEqual(fixture.releases, [undefined]);
    });
  }

  it("preserves original error and discards client if rollback fails", async () => {
    const failure = new Error("grant failure");
    const rollbackFailure = new Error("connection lost during rollback");
    const fixture = scriptedStore([begin, insert, wallet, { ...update, error: failure }, { ...rollback, error: rollbackFailure }]);
    await assert.rejects(fixture.store.applyTransaction("google", "tx", record, effect), (error) => error === failure);
    assert.deepEqual(fixture.releases, [rollbackFailure]);
  });

  it("releases a client when BEGIN fails and handles acquisition failure", async () => {
    const failure = new Error("begin failure");
    const fixture = scriptedStore([{ ...begin, error: failure }]);
    await assert.rejects(fixture.store.applyTransaction("google", "tx", record, effect), (error) => error === failure);
    assert.deepEqual(fixture.releases, [failure]);
    const unavailable = scriptedStore([], { connectError: failure });
    await assert.rejects(unavailable.store.applyTransaction("google", "tx", record, effect), (error) => error === failure);
    assert.equal(unavailable.releases.length, 0);
  });

  it("rolls back dedupe when the existing subscription write fails", async () => {
    const failure = new Error("subscription write failure");
    const fixture = scriptedStore([begin, insert, { sql: /INSERT INTO iap_subscriptions/, error: failure }, rollback]);
    await assert.rejects(fixture.store.applyTransaction("apple", "sub", record, { subscription: { active: true } }), (error) => error === failure);
    assert.equal(fixture.steps.length, 0);
    assert.deepEqual(fixture.releases, [undefined]);
  });

  it("keeps the existing subscription write inside the same transaction", async () => {
    const fixture = scriptedStore([begin, insert, { sql: /INSERT INTO iap_subscriptions/ }, commit]);
    await fixture.store.applyTransaction("apple", "sub", record, { subscription: { active: true, status: "active" } });
    assert.equal(fixture.steps.length, 0);
    assert.deepEqual(fixture.releases, [undefined]);
  });
});
