import http from "node:http";
import crypto from "node:crypto";
import {
  JwtValidationError,
  createSessionToken,
  createSessionTokenVerifier
} from "../../../packages/shared-utils/index.js";

export function createIdentityGatewayHttpServer(options = {}) {
  const service = options.service;
  if (!service || typeof service.authenticateCrazyGamesUser !== "function") {
    throw new Error("service.authenticateCrazyGamesUser is required");
  }
  if (typeof service.authenticateNakamaUser !== "function") {
    throw new Error("service.authenticateNakamaUser is required");
  }
  if (typeof service.createMergeCodeForProfile !== "function") {
    throw new Error("service.createMergeCodeForProfile is required");
  }
  if (typeof service.redeemMergeCodeForProfile !== "function") {
    throw new Error("service.redeemMergeCodeForProfile is required");
  }
  if (typeof service.startMagicLinkForProfile !== "function") {
    throw new Error("service.startMagicLinkForProfile is required");
  }
  if (typeof service.completeMagicLinkForProfile !== "function") {
    throw new Error("service.completeMagicLinkForProfile is required");
  }
  if (typeof service.completeMagicLinkByToken !== "function") {
    throw new Error("service.completeMagicLinkByToken is required");
  }
  if (typeof service.validateUsername !== "function") {
    throw new Error("service.validateUsername is required");
  }
  const authConfig = options.authConfig || {};
  const bodyLimitBytes = Number.isFinite(Number(options.bodyLimitBytes))
    ? Math.max(1024, Math.floor(Number(options.bodyLimitBytes)))
    : 64 * 1024;
  const cors = createCorsPolicy(options.allowedOrigins);
  const sessionConfig = {
    secret: String(options.sessionSecret || ""),
    signingAlg: String(options.sessionSigningAlg || "").trim().toUpperCase() || "HS256",
    signingKeyId: String(options.sessionSigningKeyId || "").trim(),
    signingPrivateKey: String(options.sessionPrivateKey || "").trim(),
    publicKey: String(options.sessionPublicKey || "").trim(),
    allowLegacyHmac: options.sessionAllowLegacyHmac !== false,
    requireSubject: options.requireSessionSubject === true,
    allowLegacyNakamaSubject: options.allowLegacyNakamaSubject !== false,
    issuer: String(options.sessionIssuer || ""),
    audience: String(options.sessionAudience || ""),
    ttlSeconds: Number.isFinite(Number(options.sessionTtlSeconds))
      ? Math.max(60, Math.floor(Number(options.sessionTtlSeconds)))
      : 60 * 60,
    clockSkewSeconds: Number.isFinite(Number(options.clockSkewSeconds))
      ? Math.max(0, Math.floor(Number(options.clockSkewSeconds)))
      : 10
  };
  const sessionVerifier = createSessionTokenVerifier({
    hsSecret: sessionConfig.secret,
    publicKey: sessionConfig.publicKey,
    issuer: sessionConfig.issuer || undefined,
    audience: sessionConfig.audience || undefined,
    clockSkewSeconds: sessionConfig.clockSkewSeconds,
    allowLegacyHmac: sessionConfig.allowLegacyHmac
  });
  const sessionJwkSet = normalizeJwkSet(options.sessionJwkSet);
  const sessionJwksPath = String(options.sessionJwksPath || "/.well-known/jwks.json");
  const webAuthConfig = {
    gameId: String(options.webAuthGameId || "web").trim().toLowerCase(),
    cookieName: String(options.webSessionCookieName || "tpx_session").trim() || "tpx_session",
    cookieDomain: String(options.webSessionCookieDomain || "").trim(),
    cookiePath: String(options.webSessionCookiePath || "/").trim() || "/",
    cookieSecure: options.webSessionCookieSecure !== false,
    cookieSameSite: normalizeSameSite(options.webSessionCookieSameSite),
    cookieHttpOnly: options.webSessionCookieHttpOnly !== false,
    returnOrigins: normalizeReturnOrigins(options.webReturnOrigins)
  };

  const server = http.createServer(async (req, res) => {
    const requestId = extractRequestId(req);
    res.setHeader("x-request-id", requestId);
    applyCors(req, res, cors);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    try {
      await handleRequest(req, res, {
        service,
        authConfig,
        edgeIngressSecret: String(options.edgeIngressSecret || "").trim(),
        internalServiceKey: String(options.internalServiceKey || ""),
        sessionConfig,
        sessionVerifier,
        sessionJwkSet,
        sessionJwksPath,
        webAuthConfig,
        bodyLimitBytes,
        requestId
      });
    } catch (error) {
      if (error instanceof HttpError) {
        writeJson(res, error.statusCode, {
          request_id: requestId,
          error: {
            code: error.code,
            message: error.message
          }
        });
        return;
      }
      writeJson(res, 500, {
        request_id: requestId,
        error: {
          code: "internal_error",
          message: "Internal server error"
        }
      });
      if (options.logger?.error) {
        options.logger.error(error);
      }
    }
  });

  return {
    server,
    listen: async (port = 0, host = "127.0.0.1") =>
      listenServer(server, port, host),
    close: async () => closeServer(server)
  };
}

async function handleRequest(req, res, ctx) {
  const urlPath = String(req.url || "").split("?")[0];
  if (req.method === "GET" && urlPath === "/healthz") {
    writeJson(res, 200, { ok: true, request_id: ctx.requestId });
    return;
  }

  if (req.method === "GET" && urlPath === ctx.sessionJwksPath) {
    writeJson(res, 200, {
      request_id: ctx.requestId,
      ...ctx.sessionJwkSet
    });
    return;
  }

  requireEdgeIngress(req, urlPath, {
    expected: ctx.edgeIngressSecret,
    sessionJwksPath: ctx.sessionJwksPath
  });

  if (req.method === "GET" && urlPath === "/v1/web/session") {
    const sessionToken = extractSessionCookie(
      req,
      ctx.webAuthConfig.cookieName
    );
    if (!sessionToken) {
      writeJson(res, 200, {
        request_id: ctx.requestId,
        authenticated: false
      });
      return;
    }
    try {
      const claims = await ctx.sessionVerifier.verify(sessionToken, {
        requireSubject: ctx.sessionConfig.requireSubject
      });
      const profileId = extractProfileIdFromClaims(claims, ctx.sessionConfig);
      writeJson(res, 200, {
        request_id: ctx.requestId,
        authenticated: !!profileId,
        terapixel_user_id: profileId,
        terapixel_email: String(claims?.email || "").trim().toLowerCase(),
        terapixel_display_name: String(claims?.display_name || "").trim()
      });
      return;
    } catch (_error) {
      setSessionCookie(res, ctx.webAuthConfig, "", 0);
      writeJson(res, 200, {
        request_id: ctx.requestId,
        authenticated: false
      });
      return;
    }
  }

  if (
    (req.method === "POST" && urlPath === "/v1/web/logout") ||
    (req.method === "GET" && urlPath === "/v1/web/logout")
  ) {
    setSessionCookie(res, ctx.webAuthConfig, "", 0);
    if (req.method === "GET") {
      const reqUrl = new URL(req.url, "http://identity.local");
      const returnTo = sanitizeReturnTo(
        reqUrl.searchParams.get("return_to"),
        ctx.webAuthConfig.returnOrigins
      );
      if (returnTo) {
        res.statusCode = 302;
        res.setHeader("location", appendQueryParams(returnTo, { logout: "1" }));
        res.end();
        return;
      }
    }
    writeJson(res, 200, {
      request_id: ctx.requestId,
      ok: true
    });
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/v1/web/login")) {
    const reqUrl = new URL(req.url, "http://identity.local");
    const email = normalizeEmail(reqUrl.searchParams.get("email"));
    const returnTo = sanitizeReturnTo(
      reqUrl.searchParams.get("return_to"),
      ctx.webAuthConfig.returnOrigins
    );
    if (!email) {
      writeHtml(
        res,
        200,
        renderWebLoginPage({
          status: "idle",
          returnTo
        })
      );
      return;
    }
    if (!isValidEmail(email)) {
      writeHtml(
        res,
        400,
        renderWebLoginPage({
          status: "invalid_email",
          email,
          returnTo
        })
      );
      return;
    }
    try {
      await ctx.service.startMagicLinkForProfile({
        gameId: ctx.webAuthConfig.gameId,
        profileId: createWebProfileId(email),
        email,
        returnTo,
        requestId: ctx.requestId
      });
    } catch (error) {
      writeHtml(
        res,
        400,
        renderWebLoginPage({
          status: "start_failed",
          email,
          returnTo,
          error: error?.message
        })
      );
      return;
    }
    writeHtml(
      res,
      200,
      renderWebLoginPage({
        status: "email_sent",
        email,
        returnTo
      })
    );
    return;
  }

  if (req.method === "POST" && req.url === "/v1/web/login/start") {
    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
    const email = normalizeEmail(body.email);
    const returnTo = sanitizeReturnTo(
      body.return_to || body.returnTo || "",
      ctx.webAuthConfig.returnOrigins
    );
    if (!isValidEmail(email)) {
      throw new HttpError(400, "invalid_request", "email is required");
    }
    let result;
    try {
      result = await ctx.service.startMagicLinkForProfile({
        gameId: ctx.webAuthConfig.gameId,
        profileId: createWebProfileId(email),
        email,
        returnTo,
        requestId: ctx.requestId
      });
    } catch (error) {
      throw new HttpError(400, "invalid_request", error.message);
    }
    writeJson(res, 200, {
      request_id: ctx.requestId,
      accepted: result.accepted === true,
      expires_at: result.expiresAt || 0
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/auth/crazygames") {
    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
    const token = String(body.token || "");
    if (!token) {
      throw new HttpError(400, "invalid_request", "token is required");
    }

    try {
      const result = await ctx.service.authenticateCrazyGamesUser({
        token,
        keyStore: ctx.authConfig.keyStore,
        expectedIssuer: ctx.authConfig.expectedIssuer,
        expectedAudience: ctx.authConfig.expectedAudience,
        clockSkewSeconds: ctx.authConfig.clockSkewSeconds,
        nowSeconds: body.nowSeconds
      });

      writeJson(res, 200, {
        request_id: ctx.requestId,
        player_id: result.player.playerId,
        display_name: result.player.displayName || "",
        is_new_player: result.isNewPlayer,
        provider: result.provider,
        provider_user_id: result.providerUserId,
        created_at: result.player.createdAt,
        last_seen_at: result.player.lastSeenAt,
        session_token: result.sessionToken || "",
        session_expires_at: result.sessionExpiresAt || 0
      });
      return;
    } catch (error) {
      if (error instanceof JwtValidationError) {
        throw new HttpError(401, "invalid_token", error.message);
      }
      throw error;
    }
  }

  if (req.method === "POST" && req.url === "/v1/auth/nakama") {
    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
    const nakamaUserId = String(body.nakama_user_id || "").trim();
    const gameId = String(body.game_id || "").trim();
    if (!nakamaUserId) {
      throw new HttpError(400, "invalid_request", "nakama_user_id is required");
    }
    if (!gameId) {
      throw new HttpError(400, "invalid_request", "game_id is required");
    }

    const result = await ctx.service.authenticateNakamaUser({
      nakamaUserId,
      gameId,
      displayName: body.display_name,
      nowSeconds: body.nowSeconds
    });
    writeJson(res, 200, {
      request_id: ctx.requestId,
      player_id: result.player.playerId,
      nakama_user_id: result.player.nakamaUserId || "",
      game_id: result.player.gameId || "",
      display_name: result.player.displayName || "",
      is_new_player: result.isNewPlayer,
      created_at: result.player.createdAt,
      last_seen_at: result.player.lastSeenAt,
      session_token: result.sessionToken || "",
      session_expires_at: result.sessionExpiresAt || 0
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/account/merge/code") {
    const claims = await requireSessionClaims(req, ctx.sessionVerifier, ctx.sessionConfig);
    const primaryProfileId = extractProfileIdFromClaims(claims, ctx.sessionConfig);
    if (!primaryProfileId) {
      throw new HttpError(401, "invalid_session", "session missing subject");
    }
    const result = await ctx.service.createMergeCodeForProfile({
      primaryProfileId,
      ttlSeconds: 600
    });
    writeJson(res, 200, {
      request_id: ctx.requestId,
      merge_code: result.mergeCode,
      expires_at: result.expiresAt
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/account/merge/redeem") {
    const claims = await requireSessionClaims(req, ctx.sessionVerifier, ctx.sessionConfig);
    const secondaryProfileId = extractProfileIdFromClaims(claims, ctx.sessionConfig);
    if (!secondaryProfileId) {
      throw new HttpError(401, "invalid_session", "session missing subject");
    }
    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
    const mergeCode = String(body.merge_code || "").trim();
    if (!mergeCode) {
      throw new HttpError(400, "invalid_request", "merge_code is required");
    }
    const result = await ctx.service.redeemMergeCodeForProfile({
      secondaryProfileId,
      mergeCode
    });
    writeJson(res, 200, {
      request_id: ctx.requestId,
      primary_profile_id: result.primaryProfileId,
      secondary_profile_id: result.secondaryProfileId,
      merged_at: result.mergedAt,
      display_name: result.displayName || "",
      session_token: result.sessionToken || "",
      session_expires_at: result.sessionExpiresAt || 0
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/account/magic-link/start") {
    const claims = await requireSessionClaims(req, ctx.sessionVerifier, ctx.sessionConfig);
    const profileId = extractProfileIdFromClaims(claims, ctx.sessionConfig);
    if (!profileId) {
      throw new HttpError(401, "invalid_session", "session missing subject");
    }
    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
    let result;
    try {
      result = await ctx.service.startMagicLinkForProfile({
        gameId: body.game_id,
        profileId,
        email: body.email,
        redirectHint: body.redirect_hint,
        requestId: ctx.requestId,
        nowSeconds: body.nowSeconds
      });
    } catch (error) {
      throw new HttpError(400, "invalid_request", error.message);
    }
    writeJson(res, 200, {
      request_id: ctx.requestId,
      accepted: result.accepted === true,
      expires_at: result.expiresAt || 0
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/identity/internal/username/validate") {
    requireAdminKey(req, ctx.internalServiceKey);
    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
    const gameId = String(body.game_id || "").trim();
    const username = String(body.username || "");
    if (!gameId) {
      throw new HttpError(400, "invalid_request", "game_id is required");
    }
    if (!username.trim()) {
      throw new HttpError(400, "invalid_request", "username is required");
    }
    const result = await ctx.service.validateUsername({
      gameId,
      username
    });
    writeJson(res, 200, {
      request_id: ctx.requestId,
      game_id: gameId,
      username: username,
      normalized_username: result.normalizedUsername || "",
      allowed: result.allowed === true,
      reason: result.reason || "unknown",
      matched_token: result.matchedToken || ""
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/account/magic-link/complete") {
    const claims = await requireSessionClaims(req, ctx.sessionVerifier, ctx.sessionConfig);
    const profileId = extractProfileIdFromClaims(claims, ctx.sessionConfig);
    if (!profileId) {
      throw new HttpError(401, "invalid_session", "session missing subject");
    }
    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
    let result;
    try {
      result = await ctx.service.completeMagicLinkForProfile({
        profileId,
        token: body.ml_token || body.magic_link_token,
        nowSeconds: body.nowSeconds
      });
    } catch (error) {
      throw new HttpError(400, "invalid_request", error.message);
    }
    writeJson(res, 200, {
      request_id: ctx.requestId,
      status: result.status,
      email: result.email || "",
      primary_profile_id: result.primaryProfileId || "",
      secondary_profile_id: result.secondaryProfileId || "",
      display_name: result.displayName || ""
    });
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/v1/account/magic-link/consume")) {
    const reqUrl = new URL(req.url, "http://identity.local");
    const token = String(reqUrl.searchParams.get("ml_token") || "").trim();
    if (!token) {
      throw new HttpError(400, "invalid_request", "ml_token is required");
    }
    let result;
    try {
      result = await ctx.service.completeMagicLinkByToken({
        token
      });
    } catch (error) {
      throw new HttpError(400, "invalid_request", error.message);
    }
    const sessionSigner = buildSessionSigner(ctx.sessionConfig);
    if (!sessionSigner) {
      throw new HttpError(500, "config_error", "session signer is not configured");
    }
    const profileId = String(result.primaryProfileId || "").trim();
    if (!profileId) {
      throw new HttpError(500, "internal_error", "missing primary profile id");
    }
    const sessionToken = createSessionToken(
      {
        sub: profileId,
        scope: "player_session",
        email: String(result.email || "").trim().toLowerCase() || undefined,
        display_name: String(result.displayName || "").trim() || undefined
      },
      sessionSigner,
      {
        issuer: ctx.sessionConfig.issuer || undefined,
        audience: ctx.sessionConfig.audience || undefined,
        ttlSeconds: ctx.sessionConfig.ttlSeconds
      }
    );
    setSessionCookie(
      res,
      ctx.webAuthConfig,
      sessionToken,
      ctx.sessionConfig.ttlSeconds
    );

    const returnTo = sanitizeReturnTo(
      reqUrl.searchParams.get("return_to"),
      ctx.webAuthConfig.returnOrigins
    );
    if (returnTo) {
      const redirectUrl = appendQueryParams(returnTo, {
        tpx_auth: "1"
      });
      res.statusCode = 302;
      res.setHeader("location", redirectUrl);
      res.end();
      return;
    }

    writeHtml(
      res,
      200,
      renderMagicLinkResultPage({
        status: result.status,
        email: result.email
      })
    );
    return;
  }

  writeJson(res, 404, {
    request_id: ctx.requestId,
    error: { code: "not_found", message: "Route not found" }
  });
}

async function requireSessionClaims(req, sessionVerifier, sessionConfig) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    throw new HttpError(401, "missing_session", "missing bearer session");
  }
  try {
    return await sessionVerifier.verify(token, {
      requireSubject: sessionConfig.requireSubject
    });
  } catch (error) {
    if (error instanceof JwtValidationError) {
      throw new HttpError(401, "invalid_session", error.message);
    }
    throw error;
  }
}

function requireAdminKey(req, expectedKey) {
  const expected = String(expectedKey || "").trim();
  if (!expected) {
    throw new HttpError(500, "config_error", "internal service key not configured");
  }
  const provided = String(req.headers["x-admin-key"] || "").trim();
  if (!provided || !timingSafeEquals(provided, expected)) {
    throw new HttpError(401, "unauthorized", "invalid admin key");
  }
}

function requireEdgeIngress(req, urlPath, options = {}) {
  const expected = String(options.expected || "").trim();
  if (!expected) {
    return;
  }
  if (urlPath === "/healthz" || urlPath === String(options.sessionJwksPath || "")) {
    return;
  }
  if (urlPath.startsWith("/v1/identity/internal/")) {
    return;
  }
  const provided = String(req.headers["x-terapixel-origin-secret"] || "").trim();
  if (!provided || !timingSafeEquals(provided, expected)) {
    throw new HttpError(403, "forbidden", "missing or invalid edge ingress secret");
  }
}

function timingSafeEquals(left, right) {
  const leftBytes = Buffer.from(String(left || ""), "utf8");
  const rightBytes = Buffer.from(String(right || ""), "utf8");
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

function extractProfileIdFromClaims(claims, sessionConfig = {}) {
  if (!claims || typeof claims !== "object") {
    return "";
  }
  const sub = String(claims.sub || "").trim();
  if (sub) {
    return sub;
  }
  if (sessionConfig.allowLegacyNakamaSubject === true) {
    return String(claims.nakama_user_id || "").trim();
  }
  return "";
}

function extractBearerToken(authHeader) {
  if (typeof authHeader !== "string" || !authHeader.trim()) {
    return "";
  }
  const [scheme, token] = authHeader.trim().split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return "";
  }
  return token.trim();
}

async function readJsonBody(req, bodyLimitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    total += part.length;
    if (total > bodyLimitBytes) {
      throw new HttpError(413, "payload_too_large", "request body too large");
    }
    chunks.push(part);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    throw new HttpError(400, "invalid_json", "invalid json body");
  }
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function writeHtml(res, statusCode, body) {
  const text = String(body || "");
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(text));
  res.end(text);
}

async function listenServer(server, port, host) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const actualPort =
    addr && typeof addr === "object" && addr.port ? addr.port : port;
  return {
    port: actualPort,
    host,
    baseUrl: `http://${host}:${actualPort}`
  };
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  if (typeof server.closeIdleConnections === "function") {
    server.closeIdleConnections();
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
}

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function renderMagicLinkResultPage({ status, email }) {
  const safeStatus = escapeHtml(String(status || "unknown"));
  const safeEmail = escapeHtml(String(email || ""));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Terapixel Account Link</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #0d1321; color: #e5eef8; }
    main { max-width: 520px; margin: 10vh auto; padding: 24px; background: #1d2d44; border-radius: 12px; }
    h1 { margin: 0 0 12px 0; font-size: 28px; }
    p { margin: 8px 0; font-size: 16px; line-height: 1.5; }
    .ok { color: #b6f4c2; }
  </style>
</head>
<body>
  <main>
    <h1>Account Linked</h1>
    <p class="ok">Status: <strong>${safeStatus}</strong></p>
    <p>Email: <strong>${safeEmail}</strong></p>
    <p>You can return to the game now. Your game should update automatically.</p>
  </main>
</body>
</html>`;
}

function renderWebLoginPage({ status, email, returnTo, error }) {
  const safeEmail = escapeHtml(String(email || ""));
  const safeReturnTo = escapeHtml(String(returnTo || ""));
  const safeError = escapeHtml(String(error || ""));
  let statusText = "Enter your email to receive a sign-in link.";
  if (status === "email_sent") {
    statusText = "Magic link sent. Check your email to continue.";
  } else if (status === "invalid_email") {
    statusText = "Enter a valid email address.";
  } else if (status === "start_failed") {
    statusText = safeError || "Unable to send login email.";
  }
  const isError = status === "invalid_email" || status === "start_failed";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Terapixel Login</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #0d1321; color: #e5eef8; }
    main { max-width: 520px; margin: 10vh auto; padding: 24px; background: #1d2d44; border-radius: 12px; }
    h1 { margin: 0 0 12px 0; font-size: 28px; }
    p { margin: 8px 0; font-size: 16px; line-height: 1.5; }
    input { width: 100%; box-sizing: border-box; border-radius: 8px; border: 1px solid #6b7f99; padding: 12px; margin-top: 12px; background: #f7fbff; color: #0d1321; }
    button { margin-top: 12px; width: 100%; border: 0; border-radius: 8px; padding: 12px; font-size: 16px; background: #f47907; color: #111; cursor: pointer; }
    .ok { color: #b6f4c2; }
    .err { color: #ffb4b4; }
  </style>
</head>
<body>
  <main>
    <h1>Terapixel Login</h1>
    <p class="${isError ? "err" : "ok"}">${statusText}</p>
    <form method="GET" action="/v1/web/login">
      <input type="email" name="email" value="${safeEmail}" placeholder="you@example.com" required />
      <input type="hidden" name="return_to" value="${safeReturnTo}" />
      <button type="submit">Send Magic Link</button>
    </form>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ensureObjectBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_json", "json body must be an object");
  }
}

function extractRequestId(req) {
  const headerValue = req.headers["x-request-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim().slice(0, 100);
  }
  return crypto.randomUUID();
}

function createCorsPolicy(allowedOriginsOption) {
  if (!allowedOriginsOption) {
    return { allowAny: false, origins: [] };
  }
  if (allowedOriginsOption === "*") {
    return { allowAny: true, origins: [] };
  }
  const origins = Array.isArray(allowedOriginsOption)
    ? allowedOriginsOption
    : String(allowedOriginsOption)
        .split(",")
        .map((it) => it.trim())
        .filter(Boolean);
  return { allowAny: false, origins };
}

function applyCors(req, res, cors) {
  const origin = String(req.headers.origin || "");
  if (cors.allowAny) {
    res.setHeader("access-control-allow-origin", "*");
  } else if (origin && cors.origins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-credentials", "true");
  }
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type,authorization,x-request-id"
  );
}

function extractSessionCookie(req, cookieName) {
  const header = String(req.headers.cookie || "");
  if (!header) {
    return "";
  }
  const target = `${cookieName}=`;
  const parts = header.split(";");
  for (const part of parts) {
    const item = part.trim();
    if (!item || !item.startsWith(target)) {
      continue;
    }
    return decodeURIComponent(item.slice(target.length));
  }
  return "";
}

function setSessionCookie(res, webAuthConfig, token, maxAgeSeconds) {
  const safeToken = String(token || "");
  const maxAge = Number.isFinite(Number(maxAgeSeconds))
    ? Math.max(0, Math.floor(Number(maxAgeSeconds)))
    : 0;
  const cookieParts = [
    `${webAuthConfig.cookieName}=${encodeURIComponent(safeToken)}`,
    `Path=${webAuthConfig.cookiePath}`,
    `SameSite=${webAuthConfig.cookieSameSite}`,
    `Max-Age=${maxAge}`
  ];
  if (webAuthConfig.cookieDomain) {
    cookieParts.push(`Domain=${webAuthConfig.cookieDomain}`);
  }
  if (webAuthConfig.cookieHttpOnly) {
    cookieParts.push("HttpOnly");
  }
  if (webAuthConfig.cookieSecure) {
    cookieParts.push("Secure");
  }
  res.setHeader("set-cookie", cookieParts.join("; "));
}

function buildSessionSigner(sessionConfig) {
  if (sessionConfig.signingAlg === "RS256") {
    const privateKey = String(sessionConfig.signingPrivateKey || "").trim();
    if (!privateKey) {
      return null;
    }
    return {
      alg: "RS256",
      privateKey,
      kid: String(sessionConfig.signingKeyId || "").trim()
    };
  }
  const secret = String(sessionConfig.secret || "").trim();
  if (!secret) {
    return null;
  }
  return {
    alg: "HS256",
    secret
  };
}

function normalizeJwkSet(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { keys: [] };
  }
  const keys = Array.isArray(value.keys) ? value.keys : [];
  return {
    keys
  };
}

function normalizeSameSite(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "strict") {
    return "Strict";
  }
  if (normalized === "none") {
    return "None";
  }
  return "Lax";
}

function normalizeReturnOrigins(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((it) => String(it || "").trim()).filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((it) => String(it || "").trim())
    .filter(Boolean);
}

function sanitizeReturnTo(returnToRaw, allowedOrigins) {
  const value = String(returnToRaw || "").trim();
  if (!value) {
    return "";
  }
  try {
    const parsed = new URL(value, "http://identity.local");
    if (parsed.origin === "http://identity.local") {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    if (!allowedOrigins.length) {
      return "";
    }
    if (allowedOrigins.includes(parsed.origin)) {
      return parsed.toString();
    }
    return "";
  } catch (_error) {
    return "";
  }
}

function appendQueryParams(baseUrl, params) {
  const parsed = new URL(baseUrl, "http://identity.local");
  for (const [key, rawValue] of Object.entries(params || {})) {
    const value = String(rawValue || "").trim();
    if (!value) {
      continue;
    }
    parsed.searchParams.set(key, value);
  }
  if (parsed.origin === "http://identity.local") {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return parsed.toString();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

function createWebProfileId(email) {
  const normalizedEmail = normalizeEmail(email);
  const digest = crypto.createHash("sha256").update(`web:${normalizedEmail}`).digest("hex");
  return `web_${digest.slice(0, 24)}`;
}
