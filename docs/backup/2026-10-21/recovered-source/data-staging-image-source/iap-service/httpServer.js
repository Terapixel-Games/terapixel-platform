import http from "node:http";
import crypto from "node:crypto";
import {
  JwtValidationError,
  createSessionTokenVerifier
} from "../../../packages/shared-utils/index.js";

export function createIapHttpServer(options = {}) {
  const service = options.service;
  if (!service || typeof service.verifyPurchase !== "function") {
    throw new Error("service.verifyPurchase is required");
  }
  const cors = createCorsPolicy(options.allowedOrigins);
  const bodyLimitBytes = Number.isFinite(Number(options.bodyLimitBytes))
    ? Math.max(1024, Math.floor(Number(options.bodyLimitBytes)))
    : 256 * 1024;
  const sessionConfig = {
    secret: String(options.sessionSecret || ""),
    publicKey: String(options.sessionPublicKey || ""),
    jwksKeyStore: options.sessionJwksKeyStore || null,
    allowLegacyHmac: options.allowLegacySessionHmac !== false,
    requireSubject: options.requireSessionSubject === true,
    allowLegacyNakamaSubject: options.allowLegacyNakamaSubject !== false,
    issuer: String(options.sessionIssuer || ""),
    audience: String(options.sessionAudience || ""),
    clockSkewSeconds: Number.isFinite(Number(options.clockSkewSeconds))
      ? Math.max(0, Math.floor(Number(options.clockSkewSeconds)))
      : 10
  };
  const adminKey = String(options.adminKey || "");
  if (
    !sessionConfig.secret &&
    !sessionConfig.publicKey &&
    !sessionConfig.jwksKeyStore
  ) {
    throw new Error(
      "session verification config is required (sessionSecret or sessionPublicKey/sessionJwksKeyStore)"
    );
  }
  const sessionVerifier = createSessionTokenVerifier({
    hsSecret: sessionConfig.secret,
    publicKey: sessionConfig.publicKey,
    jwksKeyStore: sessionConfig.jwksKeyStore,
    issuer: sessionConfig.issuer || undefined,
    audience: sessionConfig.audience || undefined,
    clockSkewSeconds: sessionConfig.clockSkewSeconds,
    allowLegacyHmac: sessionConfig.allowLegacyHmac
  });

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
        bodyLimitBytes,
        sessionConfig,
        sessionVerifier,
        adminKey,
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
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    writeJson(res, 200, { ok: true, request_id: ctx.requestId });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/iap/entitlements") {
    const claims = await requireSessionClaims(req, ctx.sessionVerifier, ctx.sessionConfig);
    const profileId = extractProfileIdFromClaims(claims, ctx.sessionConfig);
    if (!profileId) {
      throw new HttpError(401, "invalid_session", "session missing subject");
    }
    const result = await ctx.service.getEntitlements({
      profileId
    });
    writeJson(res, 200, {
      request_id: ctx.requestId,
      ...result
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/iap/verify") {
    const claims = await requireSessionClaims(req, ctx.sessionVerifier, ctx.sessionConfig);
    const profileId = extractProfileIdFromClaims(claims, ctx.sessionConfig);
    if (!profileId) {
      throw new HttpError(401, "invalid_session", "session missing subject");
    }
    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
    const result = await ctx.service.verifyPurchase({
      profileId,
      provider: body.provider,
      productId: body.product_id,
      gameId: body.game_id,
      exportTarget: body.export_target || req.headers["x-export-target"] || "web",
      payload: body.payload
    });
    writeJson(res, 200, {
      request_id: ctx.requestId,
      ...result
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/iap/coins/adjust") {
    const claims = await requireSessionClaims(req, ctx.sessionVerifier, ctx.sessionConfig);
    const profileId = extractProfileIdFromClaims(claims, ctx.sessionConfig);
    if (!profileId) {
      throw new HttpError(401, "invalid_session", "session missing subject");
    }
    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
    const result = await ctx.service.adjustCoins({
      profileId,
      gameId: body.game_id,
      delta: body.delta,
      reason: body.reason,
      idempotencyKey: body.idempotency_key
    });
    writeJson(res, 200, {
      request_id: ctx.requestId,
      ...result
    });
    return;
  }

  if (req.method === "POST" && isWebhookPath(url.pathname)) {
    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
  const provider = webhookProviderFromPath(url.pathname);
    await verifyWebhookSignatureStub(req, provider);
    const result = await ctx.service.applyWebhookEvent({
      provider,
      body: {
        ...body,
        export_target:
          body.export_target ||
          req.headers["x-export-target"] ||
          mapProviderToDefaultTarget(provider)
      }
    });
    writeJson(res, 202, {
      request_id: ctx.requestId,
      ...result
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/iap/internal/merge-profile") {
    if (!ctx.adminKey) {
      throw new HttpError(404, "not_found", "Route not found");
    }
    const supplied = String(req.headers["x-admin-key"] || "");
    if (!supplied || supplied !== ctx.adminKey) {
      throw new HttpError(401, "unauthorized", "invalid admin key");
    }
    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
    const primaryProfileId = String(body.primary_profile_id || "").trim();
    const secondaryProfileId = String(body.secondary_profile_id || "").trim();
    if (!primaryProfileId || !secondaryProfileId) {
      throw new HttpError(
        400,
        "invalid_request",
        "primary_profile_id and secondary_profile_id are required"
      );
    }
    const result = await ctx.service.mergeProfiles({
      primaryProfileId,
      secondaryProfileId
    });
    writeJson(res, 200, {
      request_id: ctx.requestId,
      ...result
    });
    return;
  }

  writeJson(res, 404, {
    request_id: ctx.requestId,
    error: {
      code: "not_found",
      message: "Route not found"
    }
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

function extractProfileIdFromClaims(claims, sessionConfig = {}) {
  if (!claims || typeof claims !== "object") {
    return "";
  }
  const subject = String(claims.sub || "").trim();
  if (subject) {
    return subject;
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

function isWebhookPath(pathname) {
  return [
    "/v1/iap/webhook/apple",
    "/v1/iap/webhook/google",
    "/v1/iap/webhook/paypal"
  ].includes(pathname);
}

function webhookProviderFromPath(pathname) {
  if (pathname.endsWith("/apple")) {
    return "apple";
  }
  if (pathname.endsWith("/google")) {
    return "google";
  }
  return "paypal_web";
}

function mapProviderToDefaultTarget(provider) {
  if (provider === "apple") {
    return "ios";
  }
  if (provider === "google") {
    return "android";
  }
  return "web";
}

async function verifyWebhookSignatureStub(_req, _provider) {
  return true;
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

function ensureObjectBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_json", "json body must be an object");
  }
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
  }
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type,authorization,x-request-id,x-admin-key"
  );
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
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

function extractRequestId(req) {
  const headerValue = req.headers["x-request-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim().slice(0, 100);
  }
  return crypto.randomUUID();
}
