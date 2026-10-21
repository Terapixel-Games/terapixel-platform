import path from "node:path";
import { createJwksKeyStore } from "../../../adapters/crazygames-auth/index.js";
import { resolveSessionLegacyPolicy } from "../../../packages/shared-utils/index.js";
import {
  createIapHttpServer,
  createIapService,
  InMemoryIapStore,
  JsonFileIapStore,
  PostgresIapStore
} from "../index.js";
import { createIapRuntimeConfigProvider } from "./runtimeConfigProvider.js";

async function main() {
  const config = readConfig(process.env);
  const store = await createStore(config);
  const sessionJwksKeyStore = config.sessionJwksUrl
    ? createJwksKeyStore({
        jwksUrl: config.sessionJwksUrl,
        ttlSeconds: config.sessionJwksTtlSeconds
      })
    : null;
  const runtimeConfigProvider = await createIapRuntimeConfigProvider({
    mode: config.platformConfigStoreType,
    databaseUrl: config.databaseUrl,
    serviceUrl: config.platformConfigServiceUrl,
    internalKey: config.platformConfigInternalKey,
    environment: config.platformConfigEnvironment,
    cacheTtlSeconds: config.platformConfigCacheTtlSeconds,
    encryptionKey: config.platformConfigEncryptionKey
  });
  const service = createIapService({
    store,
    providers: config.providers,
    runtimeConfigProvider
  });
  const server = createIapHttpServer({
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
      event: "iap_service_started",
      host: listenInfo.host,
      port: listenInfo.port,
      store: config.storeType,
      platformConfigStoreType: config.platformConfigStoreType,
      session_policy_environment: config.sessionLegacyPolicy.environment,
      session_legacy_cutoff_utc: config.sessionLegacyPolicy.cutoffUtc,
      session_legacy_cutoff_reached: config.sessionLegacyPolicy.cutoffReached,
      session_allow_legacy_hs256: config.sessionAllowLegacyHs256,
      session_allow_legacy_nakama_subject: config.sessionAllowLegacyNakamaSubject,
      session_require_sub: config.sessionRequireSub
    })
  );
  registerShutdownHandlers(server, store, runtimeConfigProvider);
}

async function createStore(config) {
  if (config.storeType === "postgres") {
    const pool = await createPostgresPool(config.databaseUrl);
    const store = new PostgresIapStore({ pool });
    await store.init();
    return store;
  }
  if (config.storeType === "file") {
    return new JsonFileIapStore({ filePath: config.filePath });
  }
  return new InMemoryIapStore();
}

function readConfig(env) {
  const rawType = String(env.IAP_STORE_TYPE || "memory").trim().toLowerCase();
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
    port: parseIntWithDefault(env.PORT, 8110),
    bodyLimitBytes: parseIntWithDefault(env.BODY_LIMIT_BYTES, 256 * 1024),
    allowedOrigins: env.CORS_ALLOWED_ORIGINS || "",
    sessionSecret,
    sessionPublicKey,
    sessionJwksUrl,
    sessionJwksTtlSeconds: parseIntWithDefault(env.SESSION_JWKS_TTL_SECONDS, 600),
    sessionAllowLegacyHs256: sessionLegacyPolicy.allowLegacyHs256,
    sessionAllowLegacyNakamaSubject: sessionLegacyPolicy.allowLegacyNakamaSubject,
    sessionRequireSub: sessionLegacyPolicy.requireSub,
    sessionIssuer: env.SESSION_ISSUER || "terapixel.identity",
    sessionAudience: env.SESSION_AUDIENCE || "terapixel.game",
    clockSkewSeconds: parseIntWithDefault(env.CLOCK_SKEW_SECONDS, 10),
    storeType:
      rawType === "postgres" ? "postgres" : rawType === "file" ? "file" : "memory",
    filePath:
      env.IAP_STORE_FILE_PATH ||
      path.resolve(process.cwd(), "data", "iap-service.json"),
    databaseUrl: env.DATABASE_URL || "",
    adminKey: String(
      env.IAP_ADMIN_KEY || env.INTERNAL_SERVICE_KEY || env.IDENTITY_ADMIN_KEY || ""
    ),
    providers: {
      apple: {
        sharedSecret: String(env.IAP_APPLE_SHARED_SECRET || ""),
        productionUrl: String(env.IAP_APPLE_VERIFY_URL || ""),
        sandboxUrl: String(env.IAP_APPLE_SANDBOX_VERIFY_URL || "")
      },
      google: {
        clientEmail: String(env.IAP_GOOGLE_CLIENT_EMAIL || ""),
        privateKey: String(env.IAP_GOOGLE_PRIVATE_KEY || ""),
        tokenUrl: String(env.IAP_GOOGLE_TOKEN_URL || ""),
        apiBase: String(env.IAP_GOOGLE_API_BASE || "")
      },
      paypal: {
        clientId: String(env.IAP_PAYPAL_CLIENT_ID || ""),
        clientSecret: String(env.IAP_PAYPAL_CLIENT_SECRET || ""),
        baseUrl: String(env.IAP_PAYPAL_BASE_URL || "")
      }
    },
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
    platformConfigEncryptionKey: String(env.PLATFORM_CONFIG_ENCRYPTION_KEY || ""),
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


function registerShutdownHandlers(server, store, runtimeConfigProvider) {
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) {
      return;
    }
    closing = true;
    console.info(JSON.stringify({ event: "shutdown", signal }));
    try {
      await server.close();
      if (store && typeof store.close === "function") {
        await store.close();
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

async function createPostgresPool(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for IAP_STORE_TYPE=postgres");
  }
  let pgModule;
  try {
    pgModule = await import("pg");
  } catch (_error) {
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
