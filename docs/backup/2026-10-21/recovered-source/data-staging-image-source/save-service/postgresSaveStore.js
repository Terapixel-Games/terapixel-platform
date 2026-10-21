export class PostgresSaveStore {
  constructor(options = {}) {
    this._pool = options.pool;
    this._tableName = String(options.tableName || "save_envelopes");
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
