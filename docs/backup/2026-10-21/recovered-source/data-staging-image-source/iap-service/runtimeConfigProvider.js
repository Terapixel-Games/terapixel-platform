import { createSecretCrypto } from "../../../packages/shared-utils/index.js";

export function createNoopIapRuntimeConfigProvider() {
  return {
    async getIapRuntimeConfig() {
      return null;
    },
    async close() {}
  };
}

export async function createIapRuntimeConfigProvider(options = {}) {
  const mode = String(options.mode || "none").trim().toLowerCase();
  if (mode === "postgres") {
    return createPostgresIapRuntimeConfigProvider(options);
  }
  if (mode === "http") {
    return createHttpIapRuntimeConfigProvider(options);
  }
  return createNoopIapRuntimeConfigProvider();
}

async function createPostgresIapRuntimeConfigProvider(options) {
  const databaseUrl = String(options.databaseUrl || "").trim();
  if (!databaseUrl) {
    throw new Error("iap runtime config postgres mode requires databaseUrl");
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
    async getIapRuntimeConfig(input = {}) {
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
      const envResult = await pool.query(
        `
        SELECT te.title_environment_id
        FROM cp_titles t
        JOIN cp_title_environments te ON te.title_id = t.title_id
        WHERE t.game_id = $1
          AND te.environment = $2
          AND t.status = 'active'
          AND te.status = 'active'
        LIMIT 1
      `,
        [gameId, targetEnv]
      );
      const envRow = envResult.rows[0];
      if (!envRow) {
        cache.set(cacheKey, {
          value: null,
          expiresAt: now + cacheTtlSeconds
        });
        return null;
      }
      const titleEnvironmentId = String(envRow.title_environment_id || "").trim();

      const [catalogResult, providerResult] = await Promise.all([
        pool.query(
          `
          SELECT ic.catalog
          FROM cp_iap_catalog_versions ic
          WHERE ic.title_environment_id = $1
            AND ic.status = 'active'
            AND (ic.effective_from IS NULL OR ic.effective_from <= NOW())
            AND (ic.effective_to IS NULL OR ic.effective_to > NOW())
          ORDER BY ic.version_number DESC
          LIMIT 1
        `,
          [titleEnvironmentId]
        ),
        pool.query(
          `
          SELECT provider_key, client_id_secret, client_secret_secret, base_url
          FROM cp_iap_provider_configs
          WHERE title_environment_id = $1
            AND status = 'active'
          ORDER BY provider_key ASC
        `,
          [titleEnvironmentId]
        )
      ]);

      const iapProviderConfigs = {};
      for (const row of providerResult.rows) {
        const providerKey = String(row.provider_key || "").trim().toLowerCase();
        if (!providerKey) {
          continue;
        }
        iapProviderConfigs[providerKey] = {
          clientId: crypto.decrypt(String(row.client_id_secret || "")),
          clientSecret: crypto.decrypt(String(row.client_secret_secret || "")),
          baseUrl: String(row.base_url || "").trim()
        };
      }

      const config = {
        gameId,
        environment: targetEnv,
        iapCatalog: catalogResult.rows[0]?.catalog || {},
        iapProviderConfigs
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

function createHttpIapRuntimeConfigProvider(options = {}) {
  const serviceUrl = String(options.serviceUrl || "").trim();
  if (!serviceUrl) {
    throw new Error("iap runtime config http mode requires serviceUrl");
  }
  const environment = normalizeEnvironment(options.environment || "prod");
  const internalKey = String(options.internalKey || "").trim();
  const cacheTtlSeconds = normalizeCacheTtl(options.cacheTtlSeconds);
  const cache = new Map();
  return {
    async getIapRuntimeConfig(input = {}) {
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
        throw new Error(`iap runtime config fetch failed (${response.status}): ${body}`);
      }

      const payload = await response.json();
      const config =
        payload?.config && typeof payload.config === "object" ? payload.config : null;
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
