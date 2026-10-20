import { withPostgresTransaction } from "../../../../packages/shared-utils/index.js";

export class PostgresIapStore {
  constructor(options = {}) {
    this._pool = options.pool;
    if (!this._pool || typeof this._pool.query !== "function" || typeof this._pool.connect !== "function") {
      throw new Error("PostgresIapStore requires pool.query and pool.connect");
    }
  }

  async init() {
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS iap_transactions (
        provider TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        type TEXT NOT NULL,
        product_id TEXT NOT NULL,
        raw JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (provider, external_transaction_id)
      );
    `);
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS iap_coin_balances (
        profile_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        balance INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (profile_id, game_id)
      );
    `);
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS iap_subscriptions (
        profile_id TEXT PRIMARY KEY,
        provider TEXT,
        external_subscription_id TEXT,
        status TEXT NOT NULL,
        active BOOL NOT NULL,
        expires_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async recordTransaction(provider, externalTransactionId, record) {
    const sql = `
      INSERT INTO iap_transactions (provider, external_transaction_id, profile_id, type, product_id, raw)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (provider, external_transaction_id) DO NOTHING
      RETURNING raw
    `;
    const params = [
      normalize(provider),
      normalize(externalTransactionId),
      normalize(record?.profileId),
      normalize(record?.type),
      normalize(record?.productId),
      JSON.stringify(record || {})
    ];
    const inserted = await this._pool.query(sql, params);
    if (inserted.rows.length > 0) {
      return { isNew: true, record: inserted.rows[0].raw };
    }
    const existing = await this._pool.query(
      `SELECT raw FROM iap_transactions WHERE provider = $1 AND external_transaction_id = $2 LIMIT 1`,
      [normalize(provider), normalize(externalTransactionId)]
    );
    return {
      isNew: false,
      record: existing.rows[0]?.raw || {}
    };
  }

  async getCoins(profileId) {
    const result = await this._pool.query(
      `SELECT game_id, balance FROM iap_coin_balances WHERE profile_id = $1`,
      [normalize(profileId)]
    );
    const out = {};
    for (const row of result.rows) {
      out[String(row.game_id)] = { balance: Number(row.balance) || 0 };
    }
    return out;
  }

  async addCoins(profileId, gameId, delta) {
    const sql = `
      INSERT INTO iap_coin_balances (profile_id, game_id, balance, updated_at)
      VALUES ($1, $2, GREATEST($3, 0), NOW())
      ON CONFLICT (profile_id, game_id)
      DO UPDATE SET balance = GREATEST(iap_coin_balances.balance + $3, 0), updated_at = NOW()
      RETURNING balance
    `;
    const result = await this._pool.query(sql, [
      normalize(profileId),
      normalize(gameId),
      Math.floor(Number(delta) || 0)
    ]);
    return { balance: Number(result.rows[0]?.balance) || 0 };
  }

  async getSubscription(profileId) {
    return this._getSubscription(this._pool, profileId);
  }

  async _getSubscription(executor, profileId) {
    const result = await executor.query(
      `SELECT provider, external_subscription_id, status, active, expires_at
       FROM iap_subscriptions WHERE profile_id = $1 LIMIT 1`,
      [normalize(profileId)]
    );
    const row = result.rows[0];
    if (!row) {
      return { active: false, status: "none" };
    }
    const expiresAt = row.expires_at
      ? Math.floor(new Date(row.expires_at).getTime() / 1000)
      : 0;
    return {
      provider: row.provider || "",
      externalSubscriptionId: row.external_subscription_id || "",
      status: row.status || "unknown",
      active: Boolean(row.active),
      expiresAt: expiresAt > 0 ? expiresAt : undefined
    };
  }

  async upsertSubscription(profileId, subscription) {
    await this._writeSubscription(this._pool, profileId, subscription);
    return this.getSubscription(profileId);
  }

  async _writeSubscription(executor, profileId, subscription) {
    const expiresAt = Number(subscription?.expiresAt);
    await executor.query(
      `
      INSERT INTO iap_subscriptions (profile_id, provider, external_subscription_id, status, active, expires_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (profile_id)
      DO UPDATE SET provider = EXCLUDED.provider,
                    external_subscription_id = EXCLUDED.external_subscription_id,
                    status = EXCLUDED.status,
                    active = EXCLUDED.active,
                    expires_at = EXCLUDED.expires_at,
                    updated_at = NOW()
    `,
      [
        normalize(profileId),
        normalize(subscription?.provider),
        normalize(subscription?.externalSubscriptionId),
        normalize(subscription?.status || "none"),
        Boolean(subscription?.active),
        Number.isFinite(expiresAt) && expiresAt > 0
          ? new Date(expiresAt * 1000).toISOString()
          : null
      ]
    );
  }

  async mergeProfiles(primaryProfileId, secondaryProfileId) {
    const primary = normalize(primaryProfileId);
    const secondary = normalize(secondaryProfileId);
    if (!primary || !secondary || primary === secondary) {
      return { merged: false };
    }

    return withPostgresTransaction(this._pool, async (client) => {
      // Rare account merges serialize writers on these tables, including legacy
      // callers that do not participate in application-specific advisory locks.
      // Reads remain available. Keep the whole transfer on this client.
      await client.query("LOCK TABLE iap_coin_balances, iap_subscriptions IN SHARE ROW EXCLUSIVE MODE");
      const secondaryCoins = await client.query(
        `SELECT game_id, balance FROM iap_coin_balances WHERE profile_id = $1`,
        [secondary]
      );
      for (const row of secondaryCoins.rows) {
        const delta = Number(row.balance) || 0;
        if (delta <= 0) {
          continue;
        }
        await client.query(
          `
          INSERT INTO iap_coin_balances (profile_id, game_id, balance, updated_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (profile_id, game_id)
          DO UPDATE SET balance = iap_coin_balances.balance + $3, updated_at = NOW()
        `,
          [primary, row.game_id, delta]
        );
      }
      await client.query(
        `UPDATE iap_coin_balances SET balance = 0, updated_at = NOW() WHERE profile_id = $1`,
        [secondary]
      );

      const primarySub = await this._getSubscription(client, primary);
      const secondarySub = await this._getSubscription(client, secondary);
      const chosen = chooseSubscription(primarySub, secondarySub);
      await this._writeSubscription(client, primary, chosen);
      await this._writeSubscription(client, secondary, {
        active: false,
        status: "merged",
        provider: chosen.provider || ""
      });
      return { merged: true };
    });
  }

  async close() {
    if (typeof this._pool.end === "function") {
      await this._pool.end();
    }
  }
}

function chooseSubscription(primarySub, secondarySub) {
  const aExp = Number(primarySub?.expiresAt) || 0;
  const bExp = Number(secondarySub?.expiresAt) || 0;
  if (primarySub?.active && !secondarySub?.active) {
    return primarySub;
  }
  if (secondarySub?.active && !primarySub?.active) {
    return secondarySub;
  }
  return bExp > aExp ? secondarySub : primarySub;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}
