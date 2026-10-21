import path from "node:path";
import { createJwksKeyStore } from "../../../adapters/crazygames-auth/index.js";
import {
  createRuntimeConfigProvider,
  createNoopRuntimeConfigProvider,
  resolveSessionLegacyPolicy
} from "../../../packages/shared-utils/index.js";
import {
  createSaveHttpServer,
  createSaveService,
  InMemorySaveStore,
  JsonFileSaveStore,
  PostgresSaveStore
} from "../index.js";

async function main() {
  const config = readConfig(process.env);
  const saveStore = await createSaveStore(config);
  const runtimeConfigProvider = await createSaveRuntimeConfigProvider(config);
  const sessionJwksKeyStore = config.sessionJwksUrl
    ? createJwksKeyStore({
        jwksUrl: config.sessionJwksUrl,
        ttlSeconds: config.sessionJwksTtlSeconds
      })
    : null;
  const service = createSaveService({
    saveStore,
    runtimeConfigProvider,
    runtimeConfigRequired: config.platformConfigStoreType !== "none"
  });
  const server = createSaveHttpServer({
    service,
    bodyLimitBytes: config.bodyLimitBytes,
    allowedOrigins: config.allowedOrigins,
    sessionSecret: config.sessionSecret,
    sessionPublicKey: config.sessionPublicKey,
    sessionJwksKeyStore,
    sessionIssuer: config.sessionIssuer,
    sessionAudience: config.sessionAudience,
    clockSkewSeconds: config.clockSkewSeconds,
    allowLegacySessionHmac: config.sessionAllowLegacyHs256,
    allowLegacyNakamaSubject: config.sessionAllowLegacyNakamaSubject,
    requireSessionSubject: config.sessionRequireSub,
    adminKey: config.adminKey,
    logger: console
  });
  const listenInfo = await server.listen(config.port, config.host);
  console.info(
    JSON.stringify({
      event: "save_service_started",
      host: listenInfo.host,
      port: listenInfo.port,
      store: config.saveStoreType,
      platformConfigStoreType: config.platformConfigStoreType,
      session_policy_environment: config.sessionLegacyPolicy.environment,
      session_legacy_cutoff_utc: config.sessionLegacyPolicy.cutoffUtc,
      session_legacy_cutoff_reached: config.sessionLegacyPolicy.cutoffReached,
      session_allow_legacy_hs256: config.sessionAllowLegacyHs256,
      session_allow_legacy_nakama_subject: config.sessionAllowLegacyNakamaSubject,
      session_require_sub: config.sessionRequireSub
    })
  );
  registerShutdownHandlers(server, saveStore, runtimeConfigProvider);
}

async function createSaveStore(config) {
  if (config.saveStoreType === "postgres") {
    const pool = await createPostgresPool(config.databaseUrl);
    const store = new PostgresSaveStore({
      pool,
      tableName: config.saveStoreTable
    });
    await store.init();
    return store;
  }
  if (config.saveStoreType === "file") {
    return new JsonFileSaveStore({
      filePath: config.saveStoreFilePath
    });
  }
  return new InMemorySaveStore();
}

function readConfig(env) {
  const saveStoreType = (env.SAVE_STORE_TYPE || "memory").toLowerCase();
  const sessionLegacyPolicy = resolveSessionLegacyPolicy(env, {
    defaultEnvironment: String(env.PLATFORM_CONFIG_ENVIRONMENT || env.DEPLOY_ENV || "prod")
  });
  const sessionSecret = String(env.SESSION_SECRET || "");
  const sessionPublicKey = String(env.SESSION_PUBLIC_KEY_PEM || "");
  const sessionJwksUrl = String(env.SESSION_JWKS_URL || "");
  if (!sessionSecret && !sessionPublicKey && !sessionJwksUrl) {
    throw new Error(
      "missing required session verifier config: set SESSION_SECRET or SESSION_PUBLIC_KEY_PEM or SESSION_JWKS_URL"
    );
  }
  return {
    host: env.HOST || "0.0.0.0",
    port: parseIntWithDefault(env.PORT, 8090),
    bodyLimitBytes: parseIntWithDefault(env.BODY_LIMIT_BYTES, 256 * 1024),
    sessionSecret,
    sessionPublicKey,
    sessionJwksUrl,
    sessionJwksTtlSeconds: parseIntWithDefault(env.SESSION_JWKS_TTL_SECONDS, 600),
    sessionAllowLegacyHs256: sessionLegacyPolicy.allowLegacyHs256,
    sessionAllowLegacyNakamaSubject: sessionLegacyPolicy.allowLegacyNakamaSubject,
    sessionRequireSub: sessionLegacyPolicy.requireSub,
    allowedOrigins: env.CORS_ALLOWED_ORIGINS || "",
    sessionIssuer: env.SESSION_ISSUER || "terapixel.identity",
    sessionAudience: env.SESSION_AUDIENCE || "terapixel.game",
    clockSkewSeconds: parseIntWithDefault(env.CLOCK_SKEW_SECONDS, 10),
    saveStoreType:
      saveStoreType === "postgres"
        ? "postgres"
        : saveStoreType === "file"
          ? "file"
          : "memory",
    saveStoreFilePath:
      env.SAVE_STORE_FILE_PATH ||
      path.resolve(process.cwd(), "data", "save-service.json"),
    saveStoreTable: env.SAVE_STORE_TABLE || "save_envelopes",
    databaseUrl: env.DATABASE_URL || "",
    adminKey: String(env.INTERNAL_SERVICE_KEY || env.IDENTITY_ADMIN_KEY || ""),
    platformConfigStoreType: String(env.PLATFORM_CONFIG_STORE_TYPE || "none"),
    platformConfigServiceUrl: String(env.PLATFORM_CONFIG_SERVICE_URL || ""),
    platformConfigInternalKey: String(
      env.PLATFORM_CONFIG_INTERNAL_KEY ||
        env.INTERNAL_SERVICE_KEY ||
        env.IDENTITY_ADMIN_KEY ||
        ""
    ),
    platformConfigEnvironment: String(
      env.PLATFORM_CONFIG_ENVIRONMENT || env.DEPLOY_ENV || "prod"
    ),
    platformConfigCacheTtlSeconds: parseIntWithDefault(
      env.PLATFORM_CONFIG_CACHE_TTL_SECONDS,
      15
    ),
    sessionLegacyPolicy
  };
}

function parseIntWithDefault(raw, fallback) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}


function registerShutdownHandlers(server, saveStore, runtimeConfigProvider) {
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) {
      return;
    }
    closing = true;
    console.info(JSON.stringify({ event: "shutdown", signal }));
    try {
      await server.close();
      if (saveStore && typeof saveStore.close === "function") {
        await saveStore.close();
      }
      if (runtimeConfigProvider && typeof runtimeConfigProvider.close === "function") {
        await runtimeConfigProvider.close();
      }
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
}

async function createSaveRuntimeConfigProvider(config) {
  const mode = String(config.platformConfigStoreType || "none").trim().toLowerCase();
  if (mode === "none") {
    return createNoopRuntimeConfigProvider();
  }
  return createRuntimeConfigProvider({
    mode,
    databaseUrl: config.databaseUrl,
    serviceUrl: config.platformConfigServiceUrl,
    internalKey: config.platformConfigInternalKey,
    environment: config.platformConfigEnvironment,
    cacheTtlSeconds: config.platformConfigCacheTtlSeconds
  });
}

async function createPostgresPool(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for SAVE_STORE_TYPE=postgres");
  }
  let pgModule;
  try {
    pgModule = await import("pg");
  } catch (error) {
    throw new Error(
      "pg dependency is missing; install with `npm install pg` for postgres store"
    );
  }
  const Pool = resolvePoolConstructor(pgModule);
  return new Pool({
    connectionString: databaseUrl
  });
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
