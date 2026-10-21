import { createPublicKey } from "node:crypto";
import { createJwksKeyStore } from "../../../adapters/crazygames-auth/index.js";
import { resolveSessionLegacyPolicy } from "../../../packages/shared-utils/index.js";
import {
  createIdentityGatewayHttpServer,
  InMemoryIdentityStore,
  PostgresIdentityStore
} from "../index.js";
import {
  createHttpMergeCoordinator,
  createIdentityGatewayService
} from "./identityGatewayService.js";
import { createMagicLinkEmailSender } from "./magicLinkEmailSender.js";
import {
  createNoopRuntimeConfigProvider,
  createRuntimeConfigProvider
} from "./platformConfigStore.js";

async function main() {
  const config = readConfig(process.env);
  const runtimeConfigProvider = await createIdentityRuntimeConfigProvider(config);
  const keyStore = createJwksKeyStore({
    jwksUrl: config.crazyGamesJwksUrl,
    ttlSeconds: config.jwksTtlSeconds
  });

  const service = createIdentityGatewayService({
    identityStore: await createIdentityStore(config),
    mergeCoordinator: createHttpMergeCoordinator({
      adminKey: config.internalServiceKey,
      iapMergeUrl: config.iapMergeUrl,
      saveMergeUrl: config.saveMergeUrl,
      flagsMergeUrl: config.flagsMergeUrl,
      telemetryMergeUrl: config.telemetryMergeUrl
    }),
    sessionSecret: config.sessionSecret,
    sessionSigningAlg: config.sessionSigningAlg,
    sessionPrivateKey: config.sessionPrivateKey,
    sessionSigningKeyId: config.sessionSigningKeyId,
    sessionIssuer: config.sessionIssuer,
    sessionAudience: config.sessionAudience,
    sessionTtlSeconds: config.sessionTtlSeconds,
    magicLinkBaseUrl: config.magicLinkBaseUrl,
    magicLinkMobileBaseUrl: config.magicLinkMobileBaseUrl,
    magicLinkTtlSeconds: config.magicLinkTtlSeconds,
    magicLinkRateLimitPerHour: config.magicLinkRateLimitPerHour,
    usernameModerationGlobalTokens: parseTokenList(config.usernameBlocklistGlobalRaw),
    usernameModerationByGame: parsePerGameTokenMap(config.usernameBlocklistByGameJsonRaw),
    magicLinkSigningSecret: config.magicLinkSigningSecret,
    magicLinkCompletionNotifier: createNakamaMagicLinkNotifier({
      runtimeConfigProvider,
      runtimeEnvironment: config.platformConfigEnvironment,
      targetsByGameId: config.magicLinkNakamaNotifyTargets,
      defaultGameId: config.magicLinkDefaultGameId,
      legacyNotifyUrl: config.magicLinkNakamaNotifyUrl,
      legacyNotifyHttpKey: config.magicLinkNakamaNotifyHttpKey,
      legacySharedSecret: config.magicLinkNakamaNotifySecret,
      logger: console
    }),
    magicLinkEmailSender: createMagicLinkEmailSender({
      fromEmail: config.magicLinkFromEmail,
      replyToEmail: config.magicLinkReplyToEmail,
      subject: config.magicLinkSubject,
      senderName: "Terapixel Games",
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpUser: config.smtpUser,
      smtpPass: config.smtpPass,
      smtpSecure: config.smtpSecure,
      smtpRequireTls: config.smtpRequireTls
    })
  });

  const server = createIdentityGatewayHttpServer({
    service,
    bodyLimitBytes: config.bodyLimitBytes,
    allowedOrigins: config.allowedOrigins,
    edgeIngressSecret: config.edgeIngressSecret,
    sessionSecret: config.sessionSecret,
    sessionSigningAlg: config.sessionSigningAlg,
    sessionSigningKeyId: config.sessionSigningKeyId,
    sessionPrivateKey: config.sessionPrivateKey,
    sessionPublicKey: config.sessionPublicKey,
    sessionAllowLegacyHmac: config.sessionAllowLegacyHs256,
    requireSessionSubject: config.sessionRequireSub,
    allowLegacyNakamaSubject: config.sessionAllowLegacyNakamaSubject,
    sessionIssuer: config.sessionIssuer,
    sessionAudience: config.sessionAudience,
    sessionTtlSeconds: config.sessionTtlSeconds,
    sessionJwkSet: config.sessionJwkSet,
    sessionJwksPath: config.sessionJwksPath,
    clockSkewSeconds: config.clockSkewSeconds,
    webAuthGameId: config.webAuthGameId,
    webSessionCookieName: config.webSessionCookieName,
    webSessionCookieDomain: config.webSessionCookieDomain,
    webSessionCookiePath: config.webSessionCookiePath,
    webSessionCookieSecure: config.webSessionCookieSecure,
    webSessionCookieSameSite: config.webSessionCookieSameSite,
    webSessionCookieHttpOnly: config.webSessionCookieHttpOnly,
    webReturnOrigins: config.webReturnOrigins,
    internalServiceKey: config.internalServiceKey,
    authConfig: {
      keyStore,
      expectedIssuer: config.expectedIssuer,
      expectedAudience: config.expectedAudience,
      clockSkewSeconds: config.clockSkewSeconds
    },
    logger: console
  });

  const listenInfo = await server.listen(config.port, config.host);
  console.info(
    JSON.stringify({
      event: "identity_gateway_started",
      host: listenInfo.host,
      port: listenInfo.port,
      store: config.identityStoreType,
      session_signing_alg: config.sessionSigningAlg,
      session_policy_environment: config.sessionLegacyPolicy.environment,
      session_legacy_cutoff_utc: config.sessionLegacyPolicy.cutoffUtc,
      session_legacy_cutoff_reached: config.sessionLegacyPolicy.cutoffReached,
      session_allow_legacy_hs256: config.sessionAllowLegacyHs256,
      session_allow_legacy_nakama_subject: config.sessionAllowLegacyNakamaSubject,
      session_require_sub: config.sessionRequireSub
    })
  );
  registerShutdownHandlers(server, service.identityStore, runtimeConfigProvider);
}

function readConfig(env) {
  const sessionLegacyPolicy = resolveSessionLegacyPolicy(env, {
    defaultEnvironment: String(env.PLATFORM_CONFIG_ENVIRONMENT || env.DEPLOY_ENV || "prod")
  });
  const sessionSecret = String(env.SESSION_SECRET || "").trim();
  const sessionPrivateKey = normalizePem(
    env.SESSION_SIGNING_KEY_PEM || env.SESSION_PRIVATE_KEY_PEM || ""
  );
  const sessionSigningAlg =
    String(env.SESSION_SIGNING_ALG || "")
      .trim()
      .toUpperCase() || (sessionPrivateKey ? "RS256" : "HS256");
  const sessionSigningKeyId = String(
    env.SESSION_SIGNING_KEY_ID || env.SESSION_KEY_ID || ""
  ).trim();
  if (sessionSigningAlg === "RS256" && !sessionPrivateKey) {
    throw new Error("SESSION_SIGNING_KEY_PEM is required when SESSION_SIGNING_ALG=RS256");
  }
  if (sessionSigningAlg !== "RS256" && !sessionSecret) {
    throw new Error("SESSION_SECRET is required when SESSION_SIGNING_ALG is not RS256");
  }
  const sessionPublicKey = normalizePem(
    env.SESSION_PUBLIC_KEY_PEM || derivePublicKeyPem(sessionPrivateKey)
  );
  const sessionJwkSet = buildSessionJwkSet({
    alg: sessionSigningAlg,
    keyId: sessionSigningKeyId,
    publicKey: sessionPublicKey
  });
  return {
    host: env.HOST || "0.0.0.0",
    port: parseIntWithDefault(env.PORT, 8080),
    bodyLimitBytes: parseIntWithDefault(env.BODY_LIMIT_BYTES, 64 * 1024),
    crazyGamesJwksUrl:
      env.CRAZYGAMES_JWKS_URL ||
      "https://sdk.crazygames.com/authentication/keys.json",
    expectedIssuer:
      env.CRAZYGAMES_EXPECTED_ISSUER ||
      "https://sdk.crazygames.com/authentication/",
    expectedAudience: requiredEnv(env, "CRAZYGAMES_EXPECTED_AUDIENCE"),
    allowedOrigins: env.CORS_ALLOWED_ORIGINS || "",
    edgeIngressSecret: String(env.EDGE_INGRESS_SECRET || "").trim(),
    jwksTtlSeconds: parseIntWithDefault(env.JWKS_TTL_SECONDS, 600),
    clockSkewSeconds: parseIntWithDefault(env.CLOCK_SKEW_SECONDS, 10),
    sessionSecret,
    sessionSigningAlg,
    sessionPrivateKey,
    sessionPublicKey,
    sessionSigningKeyId,
    sessionAllowLegacyHs256: sessionLegacyPolicy.allowLegacyHs256,
    sessionRequireSub: sessionLegacyPolicy.requireSub,
    sessionAllowLegacyNakamaSubject: sessionLegacyPolicy.allowLegacyNakamaSubject,
    sessionJwkSet,
    sessionJwksPath: String(env.SESSION_JWKS_PATH || "/.well-known/jwks.json"),
    sessionIssuer: env.SESSION_ISSUER || "terapixel.identity",
    sessionAudience: env.SESSION_AUDIENCE || "terapixel.game",
    sessionTtlSeconds: parseIntWithDefault(env.SESSION_TTL_SECONDS, 3600),
    webAuthGameId: String(env.WEB_AUTH_GAME_ID || "web"),
    webSessionCookieName: String(env.WEB_SESSION_COOKIE_NAME || "tpx_session"),
    webSessionCookieDomain: String(env.WEB_SESSION_COOKIE_DOMAIN || ""),
    webSessionCookiePath: String(env.WEB_SESSION_COOKIE_PATH || "/"),
    webSessionCookieSecure: parseBoolWithDefault(env.WEB_SESSION_COOKIE_SECURE, true),
    webSessionCookieSameSite: String(env.WEB_SESSION_COOKIE_SAMESITE || "Lax"),
    webSessionCookieHttpOnly: parseBoolWithDefault(env.WEB_SESSION_COOKIE_HTTPONLY, true),
    webReturnOrigins: String(env.WEB_RETURN_ORIGINS || ""),
    identityStoreType: normalizeStoreType(env.IDENTITY_STORE_TYPE || "memory"),
    databaseUrl: String(env.DATABASE_URL || ""),
    internalServiceKey: String(env.INTERNAL_SERVICE_KEY || env.IDENTITY_ADMIN_KEY || ""),
    iapMergeUrl: String(env.IAP_INTERNAL_MERGE_URL || ""),
    saveMergeUrl: String(env.SAVE_INTERNAL_MERGE_URL || ""),
    flagsMergeUrl: String(env.FLAGS_INTERNAL_MERGE_URL || ""),
    telemetryMergeUrl: String(env.TELEMETRY_INTERNAL_MERGE_URL || ""),
    magicLinkFromEmail: String(env.MAGIC_LINK_FROM_EMAIL || ""),
    magicLinkReplyToEmail: String(env.MAGIC_LINK_REPLY_TO_EMAIL || ""),
    magicLinkSubject: String(env.MAGIC_LINK_SUBJECT || "Terapixel Games Magic Link"),
    magicLinkBaseUrl: String(env.MAGIC_LINK_BASE_URL || ""),
    magicLinkMobileBaseUrl: String(env.MAGIC_LINK_MOBILE_BASE_URL || ""),
    magicLinkSigningSecret: String(env.MAGIC_LINK_SIGNING_SECRET || ""),
    magicLinkTtlSeconds: parseIntWithDefault(env.MAGIC_LINK_TTL_SECONDS, 900),
    magicLinkRateLimitPerHour: parseIntWithDefault(env.MAGIC_LINK_RATE_LIMIT_PER_HOUR, 5),
    usernameBlocklistGlobalRaw: String(env.USERNAME_BLOCKLIST_GLOBAL || ""),
    usernameBlocklistByGameJsonRaw: String(env.USERNAME_BLOCKLIST_BY_GAME_JSON || ""),
    magicLinkDefaultGameId: String(env.MAGIC_LINK_DEFAULT_GAME_ID || ""),
    magicLinkNakamaNotifyTargets: parseNotifyTargets(
      env.MAGIC_LINK_NAKAMA_NOTIFY_TARGETS_JSON
    ),
    magicLinkNakamaNotifyUrl: String(env.MAGIC_LINK_NAKAMA_NOTIFY_URL || ""),
    magicLinkNakamaNotifyHttpKey: String(env.MAGIC_LINK_NAKAMA_NOTIFY_HTTP_KEY || ""),
    magicLinkNakamaNotifySecret: String(env.MAGIC_LINK_NAKAMA_NOTIFY_SECRET || ""),
    platformConfigStoreType: String(env.PLATFORM_CONFIG_STORE_TYPE || "none"),
    platformConfigServiceUrl: String(env.PLATFORM_CONFIG_SERVICE_URL || ""),
    platformConfigInternalKey: String(
      env.PLATFORM_CONFIG_INTERNAL_KEY || env.INTERNAL_SERVICE_KEY || env.IDENTITY_ADMIN_KEY || ""
    ),
    platformConfigEnvironment: String(
      env.PLATFORM_CONFIG_ENVIRONMENT || env.DEPLOY_ENV || "prod"
    ),
    platformConfigCacheTtlSeconds: parseIntWithDefault(
      env.PLATFORM_CONFIG_CACHE_TTL_SECONDS,
      15
    ),
    platformConfigEncryptionKey: String(env.PLATFORM_CONFIG_ENCRYPTION_KEY || ""),
    smtpHost: String(env.SMTP_HOST || ""),
    smtpPort: parseIntWithDefault(env.SMTP_PORT, 587),
    smtpUser: String(env.SMTP_USER || ""),
    smtpPass: String(env.SMTP_PASS || ""),
    smtpSecure: parseBoolWithDefault(env.SMTP_SECURE, false),
    smtpRequireTls: parseBoolWithDefault(env.SMTP_REQUIRE_TLS, true),
    sessionLegacyPolicy
  };
}

async function createIdentityRuntimeConfigProvider(config) {
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
    cacheTtlSeconds: config.platformConfigCacheTtlSeconds,
    encryptionKey: config.platformConfigEncryptionKey
  });
}

function parseTokenList(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_error) {
      // Fall through to CSV parse.
    }
  }
  return text.split(",").map((it) => String(it || "").trim()).filter(Boolean);
}

function parsePerGameTokenMap(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out = {};
    for (const [gameId, value] of Object.entries(parsed)) {
      out[gameId] = Array.isArray(value) ? value : parseTokenList(String(value || ""));
    }
    return out;
  } catch (_error) {
    return {};
  }
}

function createNakamaMagicLinkNotifier(config) {
  const logger = config?.logger || console;
  const runtimeConfigProvider =
    config?.runtimeConfigProvider || createNoopRuntimeConfigProvider();
  const runtimeEnvironment = String(config?.runtimeEnvironment || "prod").trim().toLowerCase();
  const targetsByGameId = normalizeNotifyTargets(config?.targetsByGameId || {});
  const defaultGameId = String(config?.defaultGameId || "").trim().toLowerCase();
  const legacyNotifyUrl = String(config?.legacyNotifyUrl || "").trim();
  const legacyNotifyHttpKey = String(config?.legacyNotifyHttpKey || "").trim();
  const legacySharedSecret = String(config?.legacySharedSecret || "").trim();
  const hasLegacy =
    !!legacyNotifyUrl && !!legacyNotifyHttpKey && !!legacySharedSecret;
  const hasStaticTargets = Object.keys(targetsByGameId).length > 0 || hasLegacy;
  if (!hasStaticTargets && !runtimeConfigProvider) {
    return {
      notify: async () => ({ ok: false, skipped: true })
    };
  }
  return {
    notify: async (event) => {
      const eventGameId = String(event?.gameId || "").trim().toLowerCase();
      var target = null;
      try {
        const runtimeConfig = await runtimeConfigProvider.getIdentityRuntimeConfig({
          gameId: eventGameId,
          environment: runtimeEnvironment
        });
        if (
          runtimeConfig &&
          runtimeConfig.notifyTarget &&
          runtimeConfig.notifyTarget.notifyUrl &&
          runtimeConfig.notifyTarget.notifyHttpKey &&
          runtimeConfig.notifyTarget.sharedSecret
        ) {
          target = {
            notifyUrl: String(runtimeConfig.notifyTarget.notifyUrl || "").trim(),
            notifyHttpKey: String(runtimeConfig.notifyTarget.notifyHttpKey || "").trim(),
            sharedSecret: String(runtimeConfig.notifyTarget.sharedSecret || "").trim()
          };
        }
      } catch (runtimeError) {
        logger.warn(
          JSON.stringify({
            event: "magic_link_notify_runtime_config_lookup_failed",
            game_id: eventGameId,
            error: String(runtimeError?.message || runtimeError || "")
          })
        );
        // Fall back to static targets when runtime lookup is unavailable.
      }
      if (!target && eventGameId && targetsByGameId[eventGameId]) {
        target = targetsByGameId[eventGameId];
      }
      if (!target && defaultGameId && targetsByGameId[defaultGameId]) {
        target = targetsByGameId[defaultGameId];
      }
      if (!target && hasLegacy) {
        target = {
          notifyUrl: legacyNotifyUrl,
          notifyHttpKey: legacyNotifyHttpKey,
          sharedSecret: legacySharedSecret
        };
      }
      if (!target) {
        logger.warn(
          JSON.stringify({
            event: "magic_link_notify_skipped",
            reason: "no_target_for_game_id",
            game_id: eventGameId || "",
            environment: runtimeEnvironment
          })
        );
        return { ok: false, skipped: true, reason: "no_target_for_game_id" };
      }
      const payload = {
        secret: target.sharedSecret,
        game_id: eventGameId,
        profile_id: String(event?.profileId || ""),
        status: String(event?.status || ""),
        email: String(event?.email || ""),
        primary_profile_id: String(event?.primaryProfileId || ""),
        secondary_profile_id: String(event?.secondaryProfileId || ""),
        completed_at: Number.isFinite(Number(event?.usedAt))
          ? Math.floor(Number(event.usedAt))
          : Math.floor(Date.now() / 1000)
      };
      const notifyUrl = target.notifyUrl;
      const response = await fetch(`${notifyUrl}${notifyUrl.includes("?") ? "&" : "?"}http_key=${encodeURIComponent(target.notifyHttpKey)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(JSON.stringify(payload))
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`nakama notify failed: ${response.status} ${text}`);
      }
      logger.info(
        JSON.stringify({
          event: "magic_link_notify_delivered",
          game_id: eventGameId || "",
          notify_url: target.notifyUrl
        })
      );
      return { ok: true };
    }
  };
}

function parseNotifyTargets(raw) {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (_error) {
    return {};
  }
}

function normalizeNotifyTargets(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return out;
  }
  for (const [rawGameId, value] of Object.entries(input)) {
    const gameId = String(rawGameId || "").trim().toLowerCase();
    if (!gameId || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const notifyUrl = String(
      value.notify_url || value.notifyUrl || value.url || ""
    ).trim();
    const notifyHttpKey = String(
      value.notify_http_key || value.notifyHttpKey || value.http_key || value.httpKey || ""
    ).trim();
    const sharedSecret = String(
      value.shared_secret || value.sharedSecret || value.secret || ""
    ).trim();
    if (!notifyUrl || !notifyHttpKey || !sharedSecret) {
      continue;
    }
    out[gameId] = {
      notifyUrl,
      notifyHttpKey,
      sharedSecret
    };
  }
  return out;
}

function requiredEnv(env, key) {
  const value = String(env[key] || "");
  if (!value) {
    throw new Error(`missing required env ${key}`);
  }
  return value;
}

function parseIntWithDefault(raw, fallback) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizePem(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return text.replace(/\\n/g, "\n");
}

function derivePublicKeyPem(privateKeyPem) {
  const privateKey = String(privateKeyPem || "").trim();
  if (!privateKey) {
    return "";
  }
  try {
    return createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString("utf8");
  } catch (_error) {
    return "";
  }
}

function buildSessionJwkSet(input) {
  if (String(input.alg || "").trim().toUpperCase() !== "RS256") {
    return { keys: [] };
  }
  const publicKey = String(input.publicKey || "").trim();
  if (!publicKey) {
    throw new Error("SESSION_PUBLIC_KEY_PEM (or derivable private key) is required for RS256");
  }
  const key = createPublicKey(publicKey).export({ format: "jwk" });
  key.kid = String(input.keyId || "").trim();
  key.alg = "RS256";
  key.use = "sig";
  if (!key.kid) {
    throw new Error("SESSION_SIGNING_KEY_ID is required for RS256");
  }
  return {
    keys: [key]
  };
}

function parseBoolWithDefault(raw, fallback) {
  if (typeof raw === "boolean") {
    return raw;
  }
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

function registerShutdownHandlers(server, identityStore, runtimeConfigProvider) {
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) {
      return;
    }
    closing = true;
    console.info(JSON.stringify({ event: "shutdown", signal }));
    try {
      await server.close();
      if (runtimeConfigProvider && typeof runtimeConfigProvider.close === "function") {
        await runtimeConfigProvider.close();
      }
      if (identityStore && typeof identityStore.close === "function") {
        await identityStore.close();
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

async function createIdentityStore(config) {
  if (config.identityStoreType === "postgres") {
    const pool = await createPostgresPool(config.databaseUrl);
    const store = new PostgresIdentityStore({ pool });
    await store.init();
    return store;
  }
  return new InMemoryIdentityStore();
}

function normalizeStoreType(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "postgres") {
    return "postgres";
  }
  return "memory";
}

async function createPostgresPool(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for IDENTITY_STORE_TYPE=postgres");
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
