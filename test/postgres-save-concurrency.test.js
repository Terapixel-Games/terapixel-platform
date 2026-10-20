import { it } from "node:test";
import assert from "node:assert/strict";
import { PostgresSaveStore, createSaveService, createDefaultSaveEnvelope, SaveConflictError } from "../services/save-service/index.js";
const env = (profileId, payload = {}, revision = 1) => createDefaultSaveEnvelope({ gameId: "game", profileId, revision, updatedAt: 1_800_000_000, payload });
it("Postgres CAS protects absent rows and conditional revisions (mock SQL)", async () => {
  let query;
  const store = new PostgresSaveStore({ pool: { async query(sql, params) { query = { sql, params }; return { rows: [] }; } } });
  assert.equal((await store.compareAndSwap(env("primary"), null)).applied, false);
  assert.match(query.sql, /ON CONFLICT.*DO NOTHING RETURNING envelope/);
  assert.doesNotMatch(query.sql, /DO UPDATE/);
  assert.equal((await store.compareAndSwap(env("primary", {}, 3), 2)).applied, false);
  assert.match(query.sql, /WHERE.*game_id.*profile_id.*envelope->>'revision'.*\$4/s);
  assert.equal(query.params[3], 2);
  const snapshot = env("primary", { concurrent: true }, 2);
  await store.compareAndSwap(env("primary", {}, 3), 2, snapshot);
  assert.match(query.sql, /AND envelope = \$5::jsonb/);
  assert.deepEqual(JSON.parse(query.params[4]), snapshot);
});
function scripted(steps) {
  const released = [];
  return { released, store: new PostgresSaveStore({ pool: {
    async query() { throw new Error("migration escaped pinned client"); },
    async connect() { return {
      async query(sql, params) {
        const step = steps.shift(); assert.ok(step, sql); assert.match(sql.replace(/\s+/g, " ").trim(), step.sql);
        step.check?.(params); if (step.error) throw step.error; return { rows: step.rows || [] };
      }, release(error) { released.push(error); }
    }; }
  } }) };
}
const begin = { sql: /^BEGIN$/ }, commit = { sql: /^COMMIT$/ }, rollback = { sql: /^ROLLBACK$/ };
const select = { sql: /^SELECT envelope.*ORDER BY profile_id FOR UPDATE/ };
const insert = { sql: /^INSERT.*DO NOTHING RETURNING envelope/, rows: [{ envelope: env("primary") }] };
const update = { sql: /^UPDATE/ }, remove = { sql: /^DELETE/ };
it("Postgres migration rolls back destination-insert races without deleting source", async () => {
  const steps = [begin, { ...select, rows: [{ envelope: env("secondary") }] }, { ...insert, rows: [] }, rollback];
  const { store, released } = scripted(steps);
  await assert.rejects(store.migrateProfileGame("game", "primary", "secondary", 1_800_000_001), SaveConflictError);
  assert.equal(steps.length, 0); assert.deepEqual(released, [undefined]);
});
it("Postgres migration retries/remerges a raced destination on a fresh transaction", async () => {
  const steps = [begin, { ...select, rows: [{ envelope: env("secondary", { games_played: 8 }) }] }, { ...insert, rows: [] }, rollback,
    begin, { ...select, rows: [{ envelope: env("secondary", { games_played: 8 }) }, { envelope: env("primary", { high_score: 90 }) }] },
    { ...update, check(params) { const result = JSON.parse(params[2]); assert.equal(result.payload.high_score, 90); assert.equal(result.payload.games_played, 8); } }, remove, commit];
  const { store, released } = scripted(steps);
  // The service lists games once, but the adapter re-reads both rows per attempt.
  store.listByProfile = async () => [env("secondary")];
  assert.deepEqual(await createSaveService({ saveStore: store }).mergeProfiles({ primaryProfileId: "primary", secondaryProfileId: "secondary", nowSeconds: 1_800_000_001 }), { merged: true, affected_games: ["game"] });
  assert.equal(steps.length, 0); assert.deepEqual(released, [undefined, undefined]);
});
it("Postgres source-delete failure rolls back the destination write and releases", async () => {
  const error = new Error("delete failed");
  const steps = [begin, { ...select, rows: [{ envelope: env("secondary") }] }, insert, { ...remove, error }, rollback];
  const { store, released } = scripted(steps);
  await assert.rejects(store.migrateProfileGame("game", "primary", "secondary", 1_800_000_001), (actual) => actual === error);
  assert.equal(steps.length, 0); assert.deepEqual(released, [undefined]);
});
