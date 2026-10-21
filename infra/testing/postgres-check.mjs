import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { PostgresSaveStore, createDefaultSaveEnvelope } from '../../services/save-service/index.js';

// Deliberately mandatory: absent/wrong URL and missing pg are failures, never skips.
const expected = 'postgresql://terapixel_test:synthetic-local-only@postgres:5432/terapixel_test';
assert.equal(process.env.DATABASE_URL, expected, 'Use the isolated Compose test database only');
const pool = new pg.Pool({ connectionString: expected, connectionTimeoutMillis: 5000, query_timeout: 10000 });
if (process.argv.includes('--preflight')) {
  try {
    const { rows } = await pool.query('SELECT current_database() AS db, current_user AS username, version() AS version');
    assert.equal(rows[0].db, 'terapixel_test');
    assert.equal(rows[0].username, 'terapixel_test');
    console.log(rows[0]);
  } finally { await pool.end(); }
} else {
  test('real PostgreSQL migrations and synthetic save CRUD remain game scoped', { timeout: 30000 }, async () => {
    try {
      const migrations = await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
      assert.ok(migrations.rows[0].count > 0, 'migrations must have run');
      const store = new PostgresSaveStore({ pool, tableName: 'harness_synthetic_saves' });
      await store.init();
      assert.equal(await store.get('synthetic_a', 'synthetic_profile'), null);
      for (const gameId of ['synthetic_a', 'synthetic_b']) {
        await store.put(createDefaultSaveEnvelope({ gameId, profileId: 'synthetic_profile', updatedAt: 1800000000, payload: { score: 42 } }));
      }
      const loaded = await store.get('synthetic_a', 'synthetic_profile');
      assert.equal(loaded.payload.score, 42);
      loaded.payload.score = 99;
      await store.put(loaded);
      assert.equal((await store.get('synthetic_a', 'synthetic_profile')).payload.score, 99);
      assert.equal((await store.get('synthetic_b', 'synthetic_profile')).payload.score, 42);
      assert.equal((await store.listByProfile('synthetic_profile')).length, 2);
      await store.deleteByGameAndProfile('synthetic_a', 'synthetic_profile');
      assert.equal(await store.get('synthetic_a', 'synthetic_profile'), null);
      assert.equal((await store.listByProfile('synthetic_profile')).length, 1);
    } finally { await pool.end(); }
  });
}
