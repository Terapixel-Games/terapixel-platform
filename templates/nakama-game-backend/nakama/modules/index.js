// Compatibility scaffold. Canonical maintained source lives in ArcadeCore.
var EXCHANGE_CONFIG = { platformUrl: "", gameId: "", key: "" };

function InitModule(ctx, logger, nk, initializer) {
  var env = (ctx && ctx.env) || {};
  EXCHANGE_CONFIG = {
    platformUrl: String(env.PLATFORM_IDENTITY_URL || "").trim(),
    gameId: String(env.GAME_ID || "").trim().toLowerCase(),
    key: String(env.TPX_NAKAMA_EXCHANGE_KEY || "")
  };
  initializer.registerRpc("platform_auth_exchange", rpcPlatformAuthExchange);
  logger.info("Nakama module template loaded with platform_auth_exchange RPC.");
}

function rpcPlatformAuthExchange(ctx, logger, nk, payload) {
  if (!ctx || typeof ctx.userId !== "string" || !ctx.userId.trim()) {
    throw new Error("authenticated Nakama user is required");
  }
  if (!EXCHANGE_CONFIG.platformUrl || !EXCHANGE_CONFIG.gameId) {
    throw new Error("PLATFORM_IDENTITY_URL and GAME_ID are required");
  }
  if (EXCHANGE_CONFIG.key.length < 32 || !/^[A-Za-z0-9_-]+$/.test(EXCHANGE_CONFIG.key)) {
    throw new Error("TPX_NAKAMA_EXCHANGE_KEY is not configured correctly");
  }
  const parsed = parsePayload(payload);
  const response = nk.httpRequest(
    `${EXCHANGE_CONFIG.platformUrl}/v1/auth/nakama`,
    "post",
    { "content-type": "application/json", "x-nakama-exchange-key": EXCHANGE_CONFIG.key },
    JSON.stringify({ game_id: EXCHANGE_CONFIG.gameId, nakama_user_id: ctx.userId, display_name: parsed.display_name || ctx.username || "" }),
    5000,
    false
  );
  if (response.code < 200 || response.code >= 300) {
    logger.error(`platform_auth_exchange failed code=${response.code}`);
    throw new Error("platform auth exchange failed");
  }
  return response.body;
}

function parsePayload(payload) {
  if (!payload) return {};
  const parsed = JSON.parse(payload);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("payload must be an object");
  }
  return parsed;
}
