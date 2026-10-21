import crypto from "node:crypto";
import { verifyCrazyGamesToken } from "../../../adapters/crazygames-auth/index.js";
import { createSessionToken } from "../../../packages/shared-utils/index.js";
import { InMemoryIdentityStore } from "./identityStore.js";

export function createIdentityGatewayService(options = {}) {
  const identityStore = options.identityStore || new InMemoryIdentityStore();
  const mergeCoordinator = options.mergeCoordinator || createNoopMergeCoordinator();
  const magicLinkCompletionNotifier =
    options.magicLinkCompletionNotifier || createNoopMagicLinkCompletionNotifier();
  const magicLinkConfig = {
    baseUrl: String(options.magicLinkBaseUrl || "").trim(),
    mobileBaseUrl: String(options.magicLinkMobileBaseUrl || "").trim(),
    ttlSeconds: Number.isFinite(Number(options.magicLinkTtlSeconds))
      ? Math.max(60, Math.floor(Number(options.magicLinkTtlSeconds)))
      : 900,
    emailSender: options.magicLinkEmailSender || createNoopMagicLinkEmailSender(),
    signingSecret: String(options.magicLinkSigningSecret || ""),
    rateLimitPerHour: Number.isFinite(Number(options.magicLinkRateLimitPerHour))
      ? Math.max(1, Math.floor(Number(options.magicLinkRateLimitPerHour)))
      : 5
  };
  const magicLinkRateStore = new Map();
  const sessionConfig = {
    signer: normalizeSessionSigner(options),
    issuer: String(options.sessionIssuer || "terapixel.identity"),
    audience: String(options.sessionAudience || "terapixel.game"),
    ttlSeconds: Number.isFinite(Number(options.sessionTtlSeconds))
      ? Math.max(60, Math.floor(Number(options.sessionTtlSeconds)))
      : 60 * 60
  };
  const usernameModeration = {
    globalTokens: normalizeTokenList(options.usernameModerationGlobalTokens),
    byGame: normalizeGameTokenMap(options.usernameModerationByGame)
  };

  return {
    identityStore,
    authenticateCrazyGamesUser: async (input) => {
      const now = normalizeNow(input?.nowSeconds);
      const verified = await verifyCrazyGamesToken(input);
      const existing = await identityStore.findPlayerByProvider(
        verified.provider,
        verified.providerUserId
      );
      if (existing) {
        const updated = {
          ...existing,
          displayName: verified.displayName || existing.displayName,
          lastSeenAt: now
        };
        await identityStore.upsertProviderLink(
          verified.provider,
          verified.providerUserId,
          updated
        );
        return {
          isNewPlayer: false,
          player: updated,
          provider: verified.provider,
          providerUserId: verified.providerUserId,
          ...buildSession(updated.playerId, now, sessionConfig, {
            nakamaUserId: updated.nakamaUserId,
            displayName: updated.displayName
          })
        };
      }

      const player = {
        playerId: createDeterministicPlayerId(
          verified.provider,
          verified.providerUserId
        ),
        displayName: verified.displayName,
        createdAt: now,
        lastSeenAt: now
      };
      await identityStore.upsertProviderLink(
        verified.provider,
        verified.providerUserId,
        player
      );
      return {
        isNewPlayer: true,
        player,
        provider: verified.provider,
        providerUserId: verified.providerUserId,
        ...buildSession(player.playerId, now, sessionConfig, {
          displayName: player.displayName
        })
      };
    },
    authenticateNakamaUser: async (input) => {
      const gameId = normalizeGameId(input?.gameId);
      const nakamaUserId = normalizeNakamaUserId(input?.nakamaUserId);
      if (!gameId) {
        throw new Error("gameId is required");
      }
      if (!nakamaUserId) {
        throw new Error("nakamaUserId is required");
      }
      const now = normalizeNow(input?.nowSeconds);
      const existing = await identityStore.findPlayerByNakama(gameId, nakamaUserId);
      if (existing) {
        const resolvedProfileId = await identityStore.resolvePrimaryProfileId(
          existing.playerId
        );
        const updated = {
          ...existing,
          playerId: resolvedProfileId,
          gameId,
          nakamaUserId,
          displayName: normalizeDisplayName(input?.displayName) || existing.displayName,
          lastSeenAt: now
        };
        await identityStore.upsertNakamaLink(gameId, nakamaUserId, updated);
        return {
          isNewPlayer: false,
          player: updated,
          ...buildSession(updated.playerId, now, sessionConfig, {
            nakamaUserId,
            displayName: updated.displayName
          })
        };
      }

      const profileId = createDeterministicPlayerId("nakama", `${gameId}:${nakamaUserId}`);
      const primaryProfileId = await identityStore.resolvePrimaryProfileId(profileId);
      const player = {
        playerId: primaryProfileId,
        gameId,
        nakamaUserId,
        displayName: normalizeDisplayName(input?.displayName),
        createdAt: now,
        lastSeenAt: now
      };
      await identityStore.upsertNakamaLink(gameId, nakamaUserId, player);
      return {
        isNewPlayer: true,
        player,
        ...buildSession(primaryProfileId, now, sessionConfig, {
          nakamaUserId,
          displayName: player.displayName
        })
      };
    },
    createMergeCodeForProfile: async ({ primaryProfileId, nowSeconds, ttlSeconds }) => {
      const primary = await identityStore.resolvePrimaryProfileId(primaryProfileId);
      const created = await identityStore.createMergeCode(primary, {
        nowSeconds,
        ttlSeconds
      });
      return {
        mergeCode: created.code,
        expiresAt: created.expiresAt
      };
    },
    redeemMergeCodeForProfile: async ({
      secondaryProfileId,
      mergeCode,
      nowSeconds
    }) => {
      const now = normalizeNow(nowSeconds);
      const redeemed = await identityStore.redeemMergeCode(
        secondaryProfileId,
        mergeCode,
        { nowSeconds }
      );
      await mergeCoordinator.mergeAll({
        primaryProfileId: redeemed.primaryProfileId,
        secondaryProfileId: redeemed.secondaryProfileId
      });
      const profileIdentity = await resolveProfileIdentity(
        identityStore,
        redeemed.primaryProfileId,
        [redeemed.secondaryProfileId]
      );
      return {
        ...redeemed,
        displayName: profileIdentity.displayName,
        ...buildSession(redeemed.primaryProfileId, now, sessionConfig, {
          displayName: profileIdentity.displayName
        })
      };
    },
    startMagicLinkForProfile: async ({
      gameId,
      profileId,
      email,
      redirectHint,
      returnTo,
      requestId,
      nowSeconds
    }) => {
      const normalizedGameId = normalizeGameId(gameId);
      if (!normalizedGameId) {
        throw new Error("gameId is required");
      }
      const now = normalizeNow(nowSeconds);
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail) {
        throw new Error("email is required");
      }
      enforceRateLimit(magicLinkRateStore, profileId, normalizedEmail, now, magicLinkConfig.rateLimitPerHour);
      const token = await identityStore.createMagicLinkToken(normalizedEmail, profileId, {
        gameId: normalizedGameId,
        nowSeconds: now,
        ttlSeconds: magicLinkConfig.ttlSeconds
      });
      const linkUrl = buildMagicLinkUrl({
        token: token.token,
        profileId,
        redirectHint,
        returnTo,
        baseUrl: magicLinkConfig.baseUrl,
        mobileBaseUrl: magicLinkConfig.mobileBaseUrl
      });
      await magicLinkConfig.emailSender.sendMagicLink({
        email: normalizedEmail,
        linkUrl,
        expiresAt: token.expiresAt,
        requestId
      });
      return {
        accepted: true,
        expiresAt: token.expiresAt
      };
    },
    completeMagicLinkForProfile: async ({
      profileId,
      token,
      nowSeconds
    }) => {
      const now = normalizeNow(nowSeconds);
      const normalizedToken = String(token || "").trim();
      if (!normalizedToken) {
        throw new Error("magic link token is required");
      }
      const consumed = await identityStore.consumeMagicLinkToken(profileId, normalizedToken, {
        nowSeconds: now
      });
      const result = await finalizeMagicLink({
        profileId: consumed.usedByProfileId || profileId,
        email: consumed.email,
        now,
        identityStore,
        mergeCoordinator
      });
      await magicLinkCompletionNotifier.notify({
        ...result,
        gameId: consumed.gameId || "",
        profileId: consumed.usedByProfileId || profileId,
        usedAt: consumed.usedAt || now
      });
      return result;
    },
    completeMagicLinkByToken: async ({ token, nowSeconds }) => {
      const now = normalizeNow(nowSeconds);
      const normalizedToken = String(token || "").trim();
      if (!normalizedToken) {
        throw new Error("magic link token is required");
      }
      const consumed = await identityStore.consumeMagicLinkToken("", normalizedToken, {
        nowSeconds: now
      });
      const sourceProfileId = consumed.profileId || consumed.usedByProfileId;
      if (!sourceProfileId) {
        throw new Error("magic link token missing profile");
      }
      const result = await finalizeMagicLink({
        profileId: sourceProfileId,
        email: consumed.email,
        now,
        identityStore,
        mergeCoordinator
      });
      await magicLinkCompletionNotifier.notify({
        ...result,
        gameId: consumed.gameId || "",
        profileId: sourceProfileId,
        usedAt: consumed.usedAt || now
      });
      return result;
    },
    validateUsername: async ({ gameId, username }) => {
      const normalizedGameId = normalizeGameId(gameId);
      if (!normalizedGameId) {
        throw new Error("gameId is required");
      }
      const normalizedUsername = normalizeUsernameCandidate(username);
      if (!normalizedUsername) {
        return {
          allowed: false,
          reason: "invalid_format",
          normalizedUsername: ""
        };
      }
      const gameTokens = usernameModeration.byGame[normalizedGameId] || [];
      const tokens = dedupeTokens(
        usernameModeration.globalTokens.concat(gameTokens)
      );
      const compact = compactToken(normalizedUsername);
      for (const token of tokens) {
        if (compact.includes(token)) {
          return {
            allowed: false,
            reason: "blocked_token",
            normalizedUsername,
            matchedToken: token
          };
        }
      }
      return {
        allowed: true,
        reason: "ok",
        normalizedUsername
      };
    }
  };
}

export function createDeterministicPlayerId(provider, providerUserId) {
  const digest = crypto
    .createHash("sha256")
    .update(`${provider}:${providerUserId}`)
    .digest("hex");
  return `player_${digest.slice(0, 24)}`;
}

export function createHttpMergeCoordinator(config = {}) {
  const adminKey = String(config.adminKey || "");
  const services = {
    iap: String(config.iapMergeUrl || "").trim(),
    save: String(config.saveMergeUrl || "").trim(),
    flags: String(config.flagsMergeUrl || "").trim(),
    telemetry: String(config.telemetryMergeUrl || "").trim()
  };
  return {
    mergeAll: async ({ primaryProfileId, secondaryProfileId }) => {
      const body = {
        primary_profile_id: primaryProfileId,
        secondary_profile_id: secondaryProfileId
      };
      for (const url of Object.values(services)) {
        if (!url) {
          continue;
        }
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-key": adminKey
          },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`merge downstream failed (${url}): ${response.status} ${text}`);
        }
      }
    }
  };
}

function createNoopMergeCoordinator() {
  return {
    mergeAll: async () => {}
  };
}

function buildSession(profileId, now, sessionConfig, identityContext = {}) {
  if (!sessionConfig.signer) {
    return {};
  }
  const nakamaUserId = normalizeNakamaUserId(identityContext.nakamaUserId);
  const displayName = normalizeDisplayName(identityContext.displayName);
  const email = normalizeEmail(identityContext.email);
  const sessionToken = createSessionToken(
    {
      sub: profileId,
      scope: "player_session",
      nakama_user_id: nakamaUserId || undefined,
      display_name: displayName || undefined,
      email: email || undefined
    },
    sessionConfig.signer,
    {
      issuer: sessionConfig.issuer,
      audience: sessionConfig.audience,
      ttlSeconds: sessionConfig.ttlSeconds,
      nowSeconds: now
    }
  );
  return {
    sessionToken,
    sessionExpiresAt: now + sessionConfig.ttlSeconds
  };
}

function normalizeGameId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeNakamaUserId(value) {
  return String(value || "").trim();
}

function normalizeDisplayName(value) {
  return String(value || "").trim();
}

function normalizeNow(nowSeconds) {
  if (Number.isFinite(Number(nowSeconds)) && Number(nowSeconds) > 0) {
    return Math.floor(Number(nowSeconds));
  }
  return Math.floor(Date.now() / 1000);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSessionSigner(options) {
  const alg = String(options.sessionSigningAlg || "").trim().toUpperCase();
  const privateKey = String(options.sessionPrivateKey || "").trim();
  const keyId = String(options.sessionSigningKeyId || "").trim();
  const secret = String(options.sessionSecret || "").trim();
  if (alg === "RS256" || privateKey) {
    return {
      alg: "RS256",
      privateKey,
      kid: keyId
    };
  }
  if (!secret) {
    return null;
  }
  return {
    alg: "HS256",
    secret
  };
}

function createNoopMagicLinkEmailSender() {
  return {
    sendMagicLink: async () => ({ accepted: true, mocked: true })
  };
}

function createNoopMagicLinkCompletionNotifier() {
  return {
    notify: async () => ({ ok: true })
  };
}

async function finalizeMagicLink({
  profileId,
  email,
  now,
  identityStore,
  mergeCoordinator
}) {
  const normalizedEmail = normalizeEmail(email);
  const currentPrimary = await identityStore.resolvePrimaryProfileId(profileId);
  const linkedProfile = await identityStore.findProfileByEmail(normalizedEmail);

  if (!linkedProfile) {
    await identityStore.upsertEmailLink(normalizedEmail, currentPrimary);
    const profileIdentity = await resolveProfileIdentity(identityStore, currentPrimary);
    return {
      status: "upgraded",
      email: normalizedEmail,
      primaryProfileId: currentPrimary,
      displayName: profileIdentity.displayName
    };
  }
  const linkedPrimary = await identityStore.resolvePrimaryProfileId(linkedProfile);
  if (linkedPrimary === currentPrimary) {
    const profileIdentity = await resolveProfileIdentity(identityStore, linkedPrimary);
    return {
      status: "already_linked",
      email: normalizedEmail,
      primaryProfileId: linkedPrimary,
      displayName: profileIdentity.displayName
    };
  }

  await identityStore.markMerged(linkedPrimary, currentPrimary, now);
  await identityStore.upsertEmailLink(normalizedEmail, linkedPrimary);
  await mergeCoordinator.mergeAll({
    primaryProfileId: linkedPrimary,
    secondaryProfileId: currentPrimary
  });
  const profileIdentity = await resolveProfileIdentity(identityStore, linkedPrimary, [
    currentPrimary
  ]);
  return {
    status: "merged",
    email: normalizedEmail,
    primaryProfileId: linkedPrimary,
    secondaryProfileId: currentPrimary,
    displayName: profileIdentity.displayName
  };
}

async function resolveProfileIdentity(identityStore, profileId, fallbackProfileIds = []) {
  const candidates = [profileId].concat(Array.isArray(fallbackProfileIds) ? fallbackProfileIds : []);
  const seen = new Set();
  let resolvedProfileId = "";
  let displayName = "";
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const player = await identityStore.getPlayer(normalized);
    if (!resolvedProfileId) {
      resolvedProfileId = normalized;
    }
    if (!displayName) {
      displayName = normalizeDisplayName(player?.displayName);
    }
    if (resolvedProfileId && displayName) {
      break;
    }
  }
  return {
    profileId: resolvedProfileId,
    displayName
  };
}

function buildMagicLinkUrl({
  token,
  profileId,
  redirectHint,
  returnTo,
  baseUrl,
  mobileBaseUrl
}) {
  const hint = String(redirectHint || "").trim().toLowerCase();
  const root = hint === "mobile" && mobileBaseUrl ? mobileBaseUrl : baseUrl;
  if (!root) {
    throw new Error("magic link base url is not configured");
  }
  const sep = root.includes("?") ? "&" : "?";
  let url = `${root}${sep}ml_token=${encodeURIComponent(token)}&profile=${encodeURIComponent(profileId)}`;
  const normalizedReturnTo = String(returnTo || "").trim();
  if (normalizedReturnTo) {
    url += `&return_to=${encodeURIComponent(normalizedReturnTo)}`;
  }
  return url;
}

function enforceRateLimit(store, profileId, email, nowSeconds, maxPerHour) {
  const key = `${String(profileId || "").trim().toLowerCase()}:${email}`;
  const windowSeconds = 3600;
  const history = store.get(key) || [];
  const kept = history.filter((it) => Number.isFinite(it) && it > nowSeconds - windowSeconds);
  if (kept.length >= maxPerHour) {
    throw new Error("rate limit exceeded");
  }
  kept.push(nowSeconds);
  store.set(key, kept);
}

function normalizeUsernameCandidate(value) {
  return String(value || "").trim().toLowerCase();
}

function compactToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeTokenList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const tokens = [];
  for (const entry of value) {
    const token = compactToken(entry);
    if (token) {
      tokens.push(token);
    }
  }
  return dedupeTokens(tokens);
}

function normalizeGameTokenMap(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return out;
  }
  for (const [rawGameId, tokenList] of Object.entries(value)) {
    const gameId = normalizeGameId(rawGameId);
    if (!gameId) {
      continue;
    }
    out[gameId] = normalizeTokenList(tokenList);
  }
  return out;
}

function dedupeTokens(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const token = String(value || "");
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
  }
  return out;
}
