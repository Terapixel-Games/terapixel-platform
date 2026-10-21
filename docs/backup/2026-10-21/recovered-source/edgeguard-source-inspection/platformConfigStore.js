import { createSecretCrypto } from "../../../packages/shared-utils/index.js";

export function createNoopRuntimeConfigProvider() {
  return {
    async getIdentityRuntimeConfig() {
      return null;
    },
    async close() {}
  };
}

export async function createRuntimeConfigProvider(options = {}) {
  const mode = String(options.mode || "none").trim().toLowerCase();
  if (mode === "postgres") {
    return createPostgresRuntimeConfigProvider(options);
  }
  if (mode === "http") {
    return createHttpRuntimeConfigProvider(options);
  }
  return createNoopRuntimeConfigProvider();
}

async function createPostgresRuntimeConfigProvider(options) {
  const databaseUrl = String(options.databaseUrl || "").trim();
  if (!databaseUrl) {
    throw new Error("platform runtime config postgres mode requires databaseUrl");
  }
  const environment = normalizeEnvironment(options.environment || "prod");
  const cacheTtlSeconds = normalizeCacheTtl(options.cacheTtlSeconds);
  const crypto = createSecretCrypto({
    encryptionKey: String(options.encryptionKey || "")
  });
  const pgModule = await import("pg");
  const Pool = resolvePoolConstructor(pgModule);
  const pool = new Pool({
    connectionString: databaseUrl
  });
  const cache = new Map();
  return {
    async getIdentityRuntimeConfig(input = {}) {
      const gameId = normalizeGameId(input.gameId);
      const targetEnv = normalizeEnvironment(input.environment || environment);
      if (!gameId) {
        return null;
      }
      const cacheKey = `${gameId}:${targetEnv}`;
      const now = nowSeconds();
      const existing = cache.get(cacheKey);
      if (existing && existing.expiresAt > now) {
        return existing.value;
      }
      const result = await pool.query(
        `
        SELECT
          ml.notify_url,
          ml.notify_http_key_secret,
          ml.shared_secret_secret,
          ml.status AS notify_status
        FROM cp_titles t
        JOIN cp_title_environments te ON te.title_id = t.title_id
        LEFT JOIN cp_magic_link_notify_targets ml ON ml.title_environment_id = te.title_environment_id
        WHERE t.game_id = $1
          AND te.environment = $2
          AND t.status = 'active'
          AND te.status = 'active'
        LIMIT 1
      `,
        [gameId, targetEnv]
      );
      const row = result.rows[0];
      if (!row || !row.notify_url || row.notify_status !== "active") {
        cache.set(cacheKey, {
          value: null,
          expiresAt: now + cacheTtlSeconds
        });
        return null;
      }
      const config = {
        gameId,
        environment: targetEnv,
        notifyTarget: {
          notifyUrl: String(row.notify_url || "").trim(),
          notifyHttpKey: crypto.decrypt(String(row.notify_http_key_secret || "")),
          sharedSecret: crypto.decrypt(String(row.shared_secret_secret || ""))
        }
      };
      cache.set(cacheKey, {
        value: config,
        expiresAt: now + cacheTtlSeconds
      });
      return config;
    },
    async close() {
      await pool.end();
    }
  };
}

function createHttpRuntimeConfigProvider(options) {
  const serviceUrl = String(options.serviceUrl || "").trim();
  if (!serviceUrl) {
    throw new Error("platform runtime config http mode requires serviceUrl");
  }
  const environment = normalizeEnvironment(options.environment || "prod");
  const internalKey = String(options.internalKey || "").trim();
  const cacheTtlSeconds = normalizeCacheTtl(options.cacheTtlSeconds);
  const cache = new Map();
  return {
    async getIdentityRuntimeConfig(input = {}) {
      const gameId = normalizeGameId(input.gameId);
      const targetEnv = normalizeEnvironment(input.environment || environment);
      if (!gameId) {
        return null;
      }
      const cacheKey = `${gameId}:${targetEnv}`;
      const now = nowSeconds();
      const existing = cache.get(cacheKey);
      if (existing && existing.expiresAt > now) {
        return existing.value;
      }
      const url = new URL("/v1/internal/runtime/identity-config", serviceUrl);
      url.searchParams.set("game_id", gameId);
      url.searchParams.set("environment", targetEnv);
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-admin-key": internalKey
        }
      });
      if (response.status === 404) {
        cache.set(cacheKey, {
          value: null,
          expiresAt: now + cacheTtlSeconds
        });
        return null;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`platform runtime config fetch failed (${response.status}): ${body}`);
      }
      const payload = await response.json();
      const config = payload?.config && typeof payload.config === "object"
        ? payload.config
        : null;
      cache.set(cacheKey, {
        value: config,
        expiresAt: now + cacheTtlSeconds
      });
      return config;
    },
    async close() {}
  };
}

function normalizeGameId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEnvironment(value) {
  const env = String(value || "").trim().toLowerCase();
  if (!env) {
    return "prod";
  }
  if (env === "staging" || env === "prod") {
    return env;
  }
  throw new Error("environment must be staging or prod");
}

function normalizeCacheTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15;
  }
  return Math.max(5, Math.floor(parsed));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function resolvePoolConstructor(pgModule) {
  const Pool =
    pgModule?.Pool ||
    pgModule?.default?.Pool ||
    (typeof pgModule?.default === "function" ? pgModule.default : null);
  if (typeof Pool !== "function") {
    throw new Error("pg Pool constructor is unavailable");
  }
  return Pool;
}
