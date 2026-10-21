import http from "node:http";
import crypto from "node:crypto";
import {
  JwtValidationError,
  createSessionTokenVerifier
} from "../../../packages/shared-utils/index.js";

export function createSaveHttpServer(options = {}) {
  const service = options.service;
  if (!service || typeof service.syncSave !== "function") {
    throw new Error("service.syncSave is required");
  }
  if (typeof service.mergeProfiles !== "function") {
    throw new Error("service.mergeProfiles is required");
  }
  const bodyLimitBytes = Number.isFinite(Number(options.bodyLimitBytes))
    ? Math.max(1024, Math.floor(Number(options.bodyLimitBytes)))
    : 256 * 1024;
  const cors = createCorsPolicy(options.allowedOrigins);

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
  const adminKey = String(options.adminKey || "");

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
  if (req.method === "GET" && req.url === "/healthz") {
    writeJson(res, 200, { ok: true, request_id: ctx.requestId });
    return;
  }
  if (req.method === "POST" && req.url === "/v1/save/sync") {
    const sessionToken = extractBearerToken(req.headers.authorization);
    if (!sessionToken) {
      throw new HttpError(401, "missing_session", "missing bearer session");
    }
    let claims;
    try {
      claims = await ctx.sessionVerifier.verify(sessionToken, {
        requireSubject: ctx.sessionConfig.requireSubject
      });
    } catch (error) {
      if (error instanceof JwtValidationError) {
        throw new HttpError(401, "invalid_session", error.message);
      }
      throw error;
    }

    const profileId = extractProfileIdFromClaims(claims, ctx.sessionConfig);
    if (!profileId) {
      throw new HttpError(401, "invalid_session", "session missing subject");
    }

    const body = await readJsonBody(req, ctx.bodyLimitBytes);
    ensureObjectBody(body);
    const gameId = String(body.game_id || "");
    if (!gameId) {
      throw new HttpError(400, "invalid_request", "game_id is required");
    }

    const clientEnvelope =
      body.client_envelope && typeof body.client_envelope === "object"
        ? body.client_envelope
        : null;

    let result;
    try {
      result = await ctx.service.syncSave({
        gameId,
        profileId,
        clientEnvelope,
        nowSeconds: body.now_seconds
      });
    } catch (error) {
      throw new HttpError(422, "invalid_request", error.message);
    }

    writeJson(res, 200, {
      request_id: ctx.requestId,
      source: result.source,
      envelope: result.envelope
    });
    return;
  }
  if (req.method === "POST" && req.url === "/v1/save/internal/merge-profile") {
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
    error: { code: "not_found", message: "Route not found" }
  });
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
