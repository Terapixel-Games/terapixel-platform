import { withPostgresTransaction } from "../../../packages/shared-utils/index.js";
import { validateCompareAndSwap, migrateSaveEnvelope } from "./saveConcurrency.js";
import { validateSaveEnvelope } from "./saveEnvelope.js";
import { SaveConflictError } from "./saveErrors.js";

export class PostgresSaveStore {
  constructor(options = {}) {
    this._pool = options.pool;
    this._tableName = String(options.tableName || "save_envelopes");
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(this._tableName)) throw new Error("invalid save table name");
    if (!this._pool || typeof this._pool.query !== "function") {
      throw new Error("PostgresSaveStore requires pool.query");
    }
  }

  async init() {
    const sql = `
      CREATE TABLE IF NOT EXISTS ${this._tableName} (
        game_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        envelope JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (game_id, profile_id)
      );
    `;
    await this._pool.query(sql);
  }

  async get(gameId, profileId) {
    const sql = `
      SELECT envelope
      FROM ${this._tableName}
      WHERE game_id = $1 AND profile_id = $2
      LIMIT 1
    `;
    const result = await this._pool.query(sql, [gameId, profileId]);
    if (!result.rows.length) {
      return null;
    }
    return result.rows[0].envelope;
  }

  async put(envelope) {
    validateSaveEnvelope(envelope);
    const sql = `
      INSERT INTO ${this._tableName} (game_id, profile_id, envelope, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (game_id, profile_id)
      DO UPDATE SET envelope = EXCLUDED.envelope, updated_at = NOW()
      RETURNING envelope
    `;
    const result = await this._pool.query(sql, [
      envelope.game_id,
      envelope.profile_id,
      JSON.stringify(envelope)
    ]);
    return result.rows[0].envelope;
  }

  async compareAndSwap(envelope, expectedRevision, expectedEnvelope) {
    validateCompareAndSwap(envelope, expectedRevision);
    const params = [envelope.game_id, envelope.profile_id, JSON.stringify(envelope)];
    const result = expectedRevision === null
      ? await this._pool.query(
          `INSERT INTO ${this._tableName} (game_id, profile_id, envelope, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW()) ON CONFLICT (game_id, profile_id) DO NOTHING RETURNING envelope`, params)
      : await this._pool.query(
          `UPDATE ${this._tableName} SET envelope = $3::jsonb, updated_at = NOW()
           WHERE game_id = $1 AND profile_id = $2 AND (envelope->>'revision')::numeric = $4::numeric
             ${expectedEnvelope === undefined ? '' : 'AND envelope = $5::jsonb'}
           RETURNING envelope`, [...params, expectedRevision, ...(expectedEnvelope === undefined ? [] : [JSON.stringify(expectedEnvelope)])]);
    return result.rows.length ? { applied: true, envelope: result.rows[0].envelope } : { applied: false };
  }

  async migrateProfileGame(gameId, primaryId, secondaryId, nowSeconds) {
    if (primaryId === secondaryId) return { migrated: false };
    if (typeof this._pool.connect !== "function") throw new Error("save migration requires pool.connect");
    return withPostgresTransaction(this._pool, async (client) => {
      // Lock existing source/destination rows in a consistent order. Missing
      // destination rows are protected by INSERT DO NOTHING plus caller retry.
      const rows = await client.query(
        `SELECT envelope FROM ${this._tableName}
         WHERE game_id = $1 AND profile_id IN ($2, $3) ORDER BY profile_id FOR UPDATE`,
        [gameId, primaryId, secondaryId]);
      const primary = rows.rows.find((row) => row.envelope.profile_id === primaryId)?.envelope;
      const secondary = rows.rows.find((row) => row.envelope.profile_id === secondaryId)?.envelope;
      const merged = migrateSaveEnvelope(primary, secondary, gameId, primaryId, secondaryId, nowSeconds);
      if (!merged) return { migrated: false };
      const params = [gameId, primaryId, JSON.stringify(merged)];
      if (primary) {
        await client.query(`UPDATE ${this._tableName} SET envelope = $3::jsonb, updated_at = NOW() WHERE game_id = $1 AND profile_id = $2`, params);
      } else {
        const inserted = await client.query(
          `INSERT INTO ${this._tableName} (game_id, profile_id, envelope, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (game_id, profile_id) DO NOTHING RETURNING envelope`, params);
        if (!inserted.rows.length) throw new SaveConflictError();
      }
      await client.query(`DELETE FROM ${this._tableName} WHERE game_id = $1 AND profile_id = $2`, [gameId, secondaryId]);
      return { migrated: true };
    });
  }

  async listByProfile(profileId) {
    const result = await this._pool.query(
      `SELECT envelope FROM ${this._tableName} WHERE profile_id = $1`,
      [profileId]
    );
    return result.rows.map((row) => row.envelope);
  }

  async deleteByGameAndProfile(gameId, profileId) {
    await this._pool.query(
      `DELETE FROM ${this._tableName} WHERE game_id = $1 AND profile_id = $2`,
      [gameId, profileId]
    );
  }

  async close() {
    if (typeof this._pool.end === "function") {
      await this._pool.end();
    }
  }
}
