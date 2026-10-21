import { localPostgresUrl } from "../tools/test-helpers/localPostgresUrl.js";
import { it } from "node:test";
import assert from "node:assert/strict";
import { PostgresSaveStore, createSaveService, createDefaultSaveEnvelope } from "../services/save-service/index.js";

it("real local PostgreSQL: concurrent save retries and atomic migration rollback", {
  skip: !process.env.SAVE_TEST_LOCAL_DATABASE_URL, timeout: 30_000
}, async () => {
  // Explicit opt-in only; never fall back to production DATABASE_URL.
  const url = localPostgresUrl(process.env.SAVE_TEST_LOCAL_DATABASE_URL);
  const { default: pg } = await import("pg");
  const schema = `save_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000 });
  let pool, created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    pool = new pg.Pool({ connectionString: url.toString(), options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: 3000 });
    const a = new PostgresSaveStore({ pool }), b = new PostgresSaveStore({ pool });
    await a.init();
    const envelope = (profile, payload) => ({ ...createDefaultSaveEnvelope({ gameId: "game", profileId: profile, updatedAt: 100 }), payload });
    // Force both services to read the same snapshot; exercise initial INSERT
    // conflict and existing-row UPDATE conflict with the real engine.
    for (const seeded of [false, true]) {
      const profile = seeded ? "existing" : "initial";
      if (seeded) await a.put(envelope(profile, {}));
      let arrivals = 0, release;
      const gate = new Promise((resolve) => { release = resolve; });
      const wrap = (store) => ({
        async get(...args) {
          const row = await store.get(...args);
          if (++arrivals <= 2) { if (arrivals === 2) release(); await gate; }
          return row;
        }, compareAndSwap: store.compareAndSwap.bind(store)
      });
      await Promise.all([
        createSaveService({ saveStore: wrap(a) }).syncSave({ gameId: "game", profileId: profile, clientEnvelope: envelope(profile, { high_score: 300, left: true }) }),
        createSaveService({ saveStore: wrap(b) }).syncSave({ gameId: "game", profileId: profile, clientEnvelope: envelope(profile, { games_played: 8, right: true }) })
      ]);
      const saved = await a.get("game", profile);
      assert.equal(saved.payload.high_score, 300); assert.equal(saved.payload.games_played, 8);
      assert.equal(saved.payload.left, true); assert.equal(saved.payload.right, true);
      assert.equal(saved.revision, seeded ? 3 : 2);
    }
    await a.put(envelope("primary", { high_score: 400 }));
    await a.put(envelope("secondary", { games_played: 9 }));
    await pool.query(`CREATE FUNCTION reject_save_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected save delete failure'; END $$`);
    await pool.query("CREATE TRIGGER reject_save_delete BEFORE DELETE ON save_envelopes FOR EACH ROW EXECUTE FUNCTION reject_save_delete()");
    await assert.rejects(a.migrateProfileGame("game", "primary", "secondary", 200), /injected save delete failure/);
    assert.equal((await a.get("game", "primary")).revision, 1);
    assert.equal((await a.get("game", "secondary")).payload.games_played, 9);
    await pool.query("DROP TRIGGER reject_save_delete ON save_envelopes");
    await a.migrateProfileGame("game", "primary", "secondary", 200);
    assert.equal((await a.get("game", "primary")).payload.games_played, 9);
    assert.equal((await a.get("game", "primary")).payload.high_score, 400);
    assert.equal(await a.get("game", "secondary"), null);

    // Hold the real source row lock after reading an absent destination, then
    // let another connection create that destination. INSERT must lose safely,
    // rollback, and the service must retry/remerge on a fresh transaction.
    await a.put(envelope("race-secondary", { games_played: 13, secondary_flag: true }));
    let entered, resume, selections = 0;
    const selected = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { resume = resolve; });
    const paused = new PostgresSaveStore({ pool: {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (/ORDER BY profile_id FOR UPDATE/.test(sql) && ++selections === 1) { entered(); await gate; }
            return result;
          }, release: client.release.bind(client)
        };
      }
    } });
    const migration = createSaveService({ saveStore: paused }).mergeProfiles({ primaryProfileId: "race-primary", secondaryProfileId: "race-secondary", nowSeconds: 200 });
    await selected;
    try {
      await createSaveService({ saveStore: b }).syncSave({ gameId: "game", profileId: "race-primary", clientEnvelope: envelope("race-primary", { high_score: 900, primary_flag: true }) });
    } finally { resume(); }
    await migration;
    const raced = await a.get("game", "race-primary");
    assert.ok(selections >= 2, "destination race must rollback and retry from fresh rows");
    assert.equal(raced.payload.high_score, 900); assert.equal(raced.payload.games_played, 13);
    assert.equal(raced.payload.primary_flag, true); assert.equal(raced.payload.secondary_flag, true);
    assert.equal(await a.get("game", "race-secondary"), null);
  } finally {
    if (pool) await pool.end();
    try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
});
