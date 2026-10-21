import crypto from "node:crypto";

export class InMemoryIdentityStore {
  constructor() {
    this._providerLinks = new Map();
    this._players = new Map();
    this._nakamaLinks = new Map();
    this._mergeMap = new Map();
    this._mergeCodes = new Map();
    this._emailLinks = new Map();
    this._magicLinks = new Map();
  }

  async findPlayerByProvider(provider, providerUserId) {
    const key = providerKey(provider, providerUserId);
    const profileId = this._providerLinks.get(key);
    if (!profileId) {
      return null;
    }
    const primary = await this.resolvePrimaryProfileId(profileId);
    return this._players.get(primary) || null;
  }

  async upsertProviderLink(provider, providerUserId, player) {
    const key = providerKey(provider, providerUserId);
    this._providerLinks.set(key, player.playerId);
    this._players.set(player.playerId, { ...player });
    return { ...player };
  }

  async findPlayerByNakama(gameId, nakamaUserId) {
    const key = nakamaKey(gameId, nakamaUserId);
    const profileId = this._nakamaLinks.get(key);
    if (!profileId) {
      return null;
    }
    const primary = await this.resolvePrimaryProfileId(profileId);
    return this._players.get(primary) || null;
  }

  async upsertNakamaLink(gameId, nakamaUserId, player) {
    const key = nakamaKey(gameId, nakamaUserId);
    this._nakamaLinks.set(key, player.playerId);
    this._players.set(player.playerId, { ...player });
    return { ...player };
  }

  async getPlayer(playerId) {
    return this._players.get(playerId) || null;
  }

  async resolvePrimaryProfileId(profileId) {
    let current = normalize(profileId);
    const visited = new Set();
    while (this._mergeMap.has(current) && !visited.has(current)) {
      visited.add(current);
      current = this._mergeMap.get(current);
    }
    return current;
  }

  async createMergeCode(primaryProfileId, options = {}) {
    const primary = await this.resolvePrimaryProfileId(primaryProfileId);
    const now = toInt(options.nowSeconds, Math.floor(Date.now() / 1000));
    const ttlSeconds = Math.max(60, toInt(options.ttlSeconds, 600));
    const code = createMergeCode();
    const codeHash = hashCode(code);
    this._mergeCodes.set(codeHash, {
      primaryProfileId: primary,
      createdAt: now,
      expiresAt: now + ttlSeconds,
      usedAt: 0,
      usedBySecondaryProfileId: ""
    });
    return {
      code,
      expiresAt: now + ttlSeconds
    };
  }

  async redeemMergeCode(secondaryProfileId, code, options = {}) {
    const now = toInt(options.nowSeconds, Math.floor(Date.now() / 1000));
    const secondary = await this.resolvePrimaryProfileId(secondaryProfileId);
    const codeHash = hashCode(code);
    const record = this._mergeCodes.get(codeHash);
    if (!record) {
      throw new Error("merge code not found");
    }
    if (record.usedAt) {
      throw new Error("merge code already used");
    }
    if (record.expiresAt < now) {
      throw new Error("merge code expired");
    }
    const primary = await this.resolvePrimaryProfileId(record.primaryProfileId);
    if (primary === secondary) {
      throw new Error("cannot merge an account into itself");
    }
    record.usedAt = now;
    record.usedBySecondaryProfileId = secondary;
    this._mergeCodes.set(codeHash, record);
    await this.markMerged(primary, secondary, now);
    return {
      primaryProfileId: primary,
      secondaryProfileId: secondary,
      mergedAt: now
    };
  }

  async markMerged(primaryProfileId, secondaryProfileId, mergedAt) {
    const primary = normalize(primaryProfileId);
    const secondary = normalize(secondaryProfileId);
    if (!primary || !secondary || primary === secondary) {
      throw new Error("invalid merge pair");
    }
    this._mergeMap.set(secondary, primary);
    return {
      primaryProfileId: primary,
      secondaryProfileId: secondary,
      mergedAt: toInt(mergedAt, Math.floor(Date.now() / 1000))
    };
  }

  async findProfileByEmail(email) {
    const key = normalize(email);
    if (!key) {
      return "";
    }
    const profileId = this._emailLinks.get(key);
    if (!profileId) {
      return "";
    }
    return this.resolvePrimaryProfileId(profileId);
  }

  async upsertEmailLink(email, profileId) {
    const key = normalize(email);
    const normalizedProfileId = normalize(profileId);
    if (!key || !normalizedProfileId) {
      throw new Error("email and profileId are required");
    }
    this._emailLinks.set(key, normalizedProfileId);
    return {
      email: key,
      profileId: normalizedProfileId
    };
  }

  async createMagicLinkToken(email, profileId, options = {}) {
    const now = toInt(options.nowSeconds, Math.floor(Date.now() / 1000));
    const ttlSeconds = Math.max(60, toInt(options.ttlSeconds, 900));
    const gameId = normalize(options.gameId || "");
    const token = createMagicLinkToken();
    const tokenHash = hashCode(token);
    this._magicLinks.set(tokenHash, {
      email: normalize(email),
      profileId: normalize(profileId),
      gameId,
      createdAt: now,
      expiresAt: now + ttlSeconds,
      usedAt: 0,
      usedByProfileId: ""
    });
    return {
      token,
      expiresAt: now + ttlSeconds
    };
  }

  async consumeMagicLinkToken(profileId, token, options = {}) {
    const requestedProfileId = normalize(profileId);
    const now = toInt(options.nowSeconds, Math.floor(Date.now() / 1000));
    const tokenHash = hashCode(token);
    const entry = this._magicLinks.get(tokenHash);
    if (!entry) {
      throw new Error("magic link token not found");
    }
    if (entry.usedAt) {
      throw new Error("magic link token already used");
    }
    if (entry.expiresAt < now) {
      throw new Error("magic link token expired");
    }
    entry.usedAt = now;
    entry.usedByProfileId = requestedProfileId || normalize(entry.profileId);
    if (!entry.usedByProfileId) {
      throw new Error("magic link token missing profile");
    }
    this._magicLinks.set(tokenHash, entry);
    return {
      email: entry.email,
      profileId: entry.profileId,
      gameId: entry.gameId || "",
      usedByProfileId: entry.usedByProfileId,
      usedAt: entry.usedAt
    };
  }
}

export class PostgresIdentityStore {
  constructor(options = {}) {
    this._pool = options.pool;
    if (!this._pool || typeof this._pool.query !== "function") {
      throw new Error("PostgresIdentityStore requires pool.query");
    }
  }

  async init() {
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS identity_provider_links (
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        created_at INT NOT NULL,
        last_seen_at INT NOT NULL,
        PRIMARY KEY (provider, provider_user_id)
      );
    `);
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS identity_merges (
        secondary_profile_id TEXT PRIMARY KEY,
        primary_profile_id TEXT NOT NULL,
        merged_at INT NOT NULL
      );
    `);
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS identity_merge_codes (
        code_hash TEXT PRIMARY KEY,
        primary_profile_id TEXT NOT NULL,
        created_at INT NOT NULL,
        expires_at INT NOT NULL,
        used_at INT,
        used_by_secondary_profile_id TEXT
      );
    `);
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS identity_nakama_links (
        game_id TEXT NOT NULL,
        nakama_user_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        created_at INT NOT NULL,
        last_seen_at INT NOT NULL,
        PRIMARY KEY (game_id, nakama_user_id)
      );
    `);
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS identity_email_links (
        email TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        created_at INT NOT NULL,
        updated_at INT NOT NULL
      );
    `);
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS identity_magic_links (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        game_id TEXT NOT NULL DEFAULT '',
        created_at INT NOT NULL,
        expires_at INT NOT NULL,
        used_at INT,
        used_by_profile_id TEXT
      );
    `);
    await this._pool.query(`
      ALTER TABLE identity_magic_links
      ADD COLUMN IF NOT EXISTS game_id TEXT NOT NULL DEFAULT '';
    `);
  }

  async findPlayerByProvider(provider, providerUserId) {
    const result = await this._pool.query(
      `SELECT profile_id, display_name, created_at, last_seen_at
       FROM identity_provider_links
       WHERE provider = $1 AND provider_user_id = $2
       LIMIT 1`,
      [normalize(provider), normalize(providerUserId)]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const profileId = await this.resolvePrimaryProfileId(row.profile_id);
    return {
      playerId: profileId,
      displayName: row.display_name || "",
      createdAt: toInt(row.created_at, 0),
      lastSeenAt: toInt(row.last_seen_at, 0)
    };
  }

  async upsertProviderLink(provider, providerUserId, player) {
    await this._pool.query(
      `
      INSERT INTO identity_provider_links (provider, provider_user_id, profile_id, display_name, created_at, last_seen_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (provider, provider_user_id)
      DO UPDATE SET profile_id = EXCLUDED.profile_id,
                    display_name = EXCLUDED.display_name,
                    last_seen_at = EXCLUDED.last_seen_at
    `,
      [
        normalize(provider),
        normalize(providerUserId),
        normalize(player.playerId),
        String(player.displayName || ""),
        toInt(player.createdAt, 0),
        toInt(player.lastSeenAt, 0)
      ]
    );
    return { ...player };
  }

  async findPlayerByNakama(gameId, nakamaUserId) {
    const result = await this._pool.query(
      `SELECT profile_id, display_name, created_at, last_seen_at
       FROM identity_nakama_links
       WHERE game_id = $1 AND nakama_user_id = $2
       LIMIT 1`,
      [normalize(gameId), normalize(nakamaUserId)]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const profileId = await this.resolvePrimaryProfileId(row.profile_id);
    return {
      playerId: profileId,
      nakamaUserId: normalize(nakamaUserId),
      gameId: normalize(gameId),
      displayName: row.display_name || "",
      createdAt: toInt(row.created_at, 0),
      lastSeenAt: toInt(row.last_seen_at, 0)
    };
  }

  async upsertNakamaLink(gameId, nakamaUserId, player) {
    await this._pool.query(
      `
      INSERT INTO identity_nakama_links (game_id, nakama_user_id, profile_id, display_name, created_at, last_seen_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (game_id, nakama_user_id)
      DO UPDATE SET profile_id = EXCLUDED.profile_id,
                    display_name = EXCLUDED.display_name,
                    last_seen_at = EXCLUDED.last_seen_at
    `,
      [
        normalize(gameId),
        normalize(nakamaUserId),
        normalize(player.playerId),
        String(player.displayName || ""),
        toInt(player.createdAt, 0),
        toInt(player.lastSeenAt, 0)
      ]
    );
    return { ...player };
  }

  async getPlayer(playerId) {
    const profileId = await this.resolvePrimaryProfileId(playerId);
    const providerRow = await this._pool.query(
      `SELECT display_name, created_at, last_seen_at
       FROM (
         SELECT display_name, created_at, last_seen_at
         FROM identity_provider_links
         WHERE profile_id = $1
         UNION ALL
         SELECT display_name, created_at, last_seen_at
         FROM identity_nakama_links
         WHERE profile_id = $1
       ) identity_links
       ORDER BY
         CASE WHEN trim(display_name) <> '' THEN 0 ELSE 1 END ASC,
         last_seen_at DESC
       LIMIT 1`,
      [profileId]
    );
    const row = providerRow.rows[0];
    if (!row) {
      return null;
    }
    return {
      playerId: profileId,
      displayName: row.display_name || "",
      createdAt: toInt(row.created_at, 0),
      lastSeenAt: toInt(row.last_seen_at, 0)
    };
  }

  async resolvePrimaryProfileId(profileId) {
    let current = normalize(profileId);
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      const result = await this._pool.query(
        `SELECT primary_profile_id FROM identity_merges WHERE secondary_profile_id = $1 LIMIT 1`,
        [current]
      );
      const row = result.rows[0];
      if (!row || !row.primary_profile_id) {
        break;
      }
      current = normalize(row.primary_profile_id);
    }
    return current;
  }

  async createMergeCode(primaryProfileId, options = {}) {
    const primary = await this.resolvePrimaryProfileId(primaryProfileId);
    const now = toInt(options.nowSeconds, Math.floor(Date.now() / 1000));
    const ttlSeconds = Math.max(60, toInt(options.ttlSeconds, 600));
    const code = createMergeCode();
    const codeHash = hashCode(code);
    await this._pool.query(
      `
      INSERT INTO identity_merge_codes (code_hash, primary_profile_id, created_at, expires_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (code_hash)
      DO UPDATE SET primary_profile_id = EXCLUDED.primary_profile_id,
                    created_at = EXCLUDED.created_at,
                    expires_at = EXCLUDED.expires_at,
                    used_at = NULL,
                    used_by_secondary_profile_id = NULL
    `,
      [codeHash, primary, now, now + ttlSeconds]
    );
    return {
      code,
      expiresAt: now + ttlSeconds
    };
  }

  async redeemMergeCode(secondaryProfileId, code, options = {}) {
    const secondary = await this.resolvePrimaryProfileId(secondaryProfileId);
    const now = toInt(options.nowSeconds, Math.floor(Date.now() / 1000));
    const codeHash = hashCode(code);

    await this._pool.query("BEGIN");
    try {
      const codeRow = await this._pool.query(
        `
        SELECT primary_profile_id, created_at, expires_at, used_at
        FROM identity_merge_codes
        WHERE code_hash = $1
        LIMIT 1
      `,
        [codeHash]
      );
      const row = codeRow.rows[0];
      if (!row) {
        throw new Error("merge code not found");
      }
      if (toInt(row.used_at, 0) > 0) {
        throw new Error("merge code already used");
      }
      if (toInt(row.expires_at, 0) < now) {
        throw new Error("merge code expired");
      }
      const primary = await this.resolvePrimaryProfileId(row.primary_profile_id);
      if (primary === secondary) {
        throw new Error("cannot merge an account into itself");
      }
      await this._pool.query(
        `UPDATE identity_merge_codes
         SET used_at = $2, used_by_secondary_profile_id = $3
         WHERE code_hash = $1`,
        [codeHash, now, secondary]
      );
      await this._pool.query(
        `
        INSERT INTO identity_merges (secondary_profile_id, primary_profile_id, merged_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (secondary_profile_id)
        DO UPDATE SET primary_profile_id = EXCLUDED.primary_profile_id,
                      merged_at = EXCLUDED.merged_at
      `,
        [secondary, primary, now]
      );
      await this._pool.query("COMMIT");
      return {
        primaryProfileId: primary,
        secondaryProfileId: secondary,
        mergedAt: now
      };
    } catch (error) {
      await this._pool.query("ROLLBACK");
      throw error;
    }
  }

  async markMerged(primaryProfileId, secondaryProfileId, mergedAt) {
    await this._pool.query(
      `
      INSERT INTO identity_merges (secondary_profile_id, primary_profile_id, merged_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (secondary_profile_id)
      DO UPDATE SET primary_profile_id = EXCLUDED.primary_profile_id,
                    merged_at = EXCLUDED.merged_at
    `,
      [normalize(secondaryProfileId), normalize(primaryProfileId), toInt(mergedAt, 0)]
    );
    return {
      primaryProfileId: normalize(primaryProfileId),
      secondaryProfileId: normalize(secondaryProfileId),
      mergedAt: toInt(mergedAt, 0)
    };
  }

  async findProfileByEmail(email) {
    const result = await this._pool.query(
      `SELECT profile_id FROM identity_email_links WHERE email = $1 LIMIT 1`,
      [normalize(email)]
    );
    const row = result.rows[0];
    if (!row || !row.profile_id) {
      return "";
    }
    return this.resolvePrimaryProfileId(row.profile_id);
  }

  async upsertEmailLink(email, profileId) {
    const now = Math.floor(Date.now() / 1000);
    const normalizedEmail = normalize(email);
    const normalizedProfileId = normalize(profileId);
    await this._pool.query(
      `
      INSERT INTO identity_email_links (email, profile_id, created_at, updated_at)
      VALUES ($1, $2, $3, $3)
      ON CONFLICT (email)
      DO UPDATE SET profile_id = EXCLUDED.profile_id,
                    updated_at = EXCLUDED.updated_at
    `,
      [normalizedEmail, normalizedProfileId, now]
    );
    return {
      email: normalizedEmail,
      profileId: normalizedProfileId
    };
  }

  async createMagicLinkToken(email, profileId, options = {}) {
    const now = toInt(options.nowSeconds, Math.floor(Date.now() / 1000));
    const ttlSeconds = Math.max(60, toInt(options.ttlSeconds, 900));
    const gameId = normalize(options.gameId || "");
    const token = createMagicLinkToken();
    const tokenHash = hashCode(token);
    await this._pool.query(
      `
      INSERT INTO identity_magic_links (token_hash, email, profile_id, game_id, created_at, expires_at, used_at, used_by_profile_id)
      VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)
      ON CONFLICT (token_hash)
      DO UPDATE SET email = EXCLUDED.email,
                    profile_id = EXCLUDED.profile_id,
                    game_id = EXCLUDED.game_id,
                    created_at = EXCLUDED.created_at,
                    expires_at = EXCLUDED.expires_at,
                    used_at = NULL,
                    used_by_profile_id = NULL
    `,
      [tokenHash, normalize(email), normalize(profileId), gameId, now, now + ttlSeconds]
    );
    return {
      token,
      expiresAt: now + ttlSeconds
    };
  }

  async consumeMagicLinkToken(profileId, token, options = {}) {
    const requestedProfileId = normalize(profileId);
    const now = toInt(options.nowSeconds, Math.floor(Date.now() / 1000));
    const tokenHash = hashCode(token);
    await this._pool.query("BEGIN");
    try {
      const result = await this._pool.query(
        `
        SELECT email, profile_id, game_id, expires_at, used_at
        FROM identity_magic_links
        WHERE token_hash = $1
        LIMIT 1
      `,
        [tokenHash]
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("magic link token not found");
      }
      if (toInt(row.used_at, 0) > 0) {
        throw new Error("magic link token already used");
      }
      if (toInt(row.expires_at, 0) < now) {
        throw new Error("magic link token expired");
      }
      const tokenProfileId = normalize(row.profile_id);
      const usedByProfileId = requestedProfileId || tokenProfileId;
      if (!usedByProfileId) {
        throw new Error("magic link token missing profile");
      }
      await this._pool.query(
        `
        UPDATE identity_magic_links
        SET used_at = $2, used_by_profile_id = $3
        WHERE token_hash = $1
      `,
        [tokenHash, now, usedByProfileId]
      );
      await this._pool.query("COMMIT");
      return {
        email: normalize(row.email),
        profileId: tokenProfileId,
        gameId: normalize(row.game_id),
        usedByProfileId,
        usedAt: now
      };
    } catch (error) {
      await this._pool.query("ROLLBACK");
      throw error;
    }
  }

  async close() {
    if (typeof this._pool.end === "function") {
      await this._pool.end();
    }
  }
}

function providerKey(provider, providerUserId) {
  return `${normalize(provider)}:${normalize(providerUserId)}`;
}

function nakamaKey(gameId, nakamaUserId) {
  return `${normalize(gameId)}::${normalize(nakamaUserId)}`;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function toInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}

function createMergeCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function createMagicLinkToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function hashCode(code) {
  return crypto
    .createHash("sha256")
    .update(normalize(code))
    .digest("hex");
}
