import crypto from "node:crypto";
import { createCatalog, resolveCatalogEntry } from "./catalog.js";
import { InMemoryIapStore } from "./store/iapStore.js";
import { createProviderRegistry } from "./providers/providerRegistry.js";
import { createNoopIapRuntimeConfigProvider } from "./runtimeConfigProvider.js";

export function createIapService(options = {}) {
  const store = options.store || new InMemoryIapStore();
  const baseCatalog = createCatalog(options.catalog || {});
  const providers =
    options.providerRegistry || createProviderRegistry(options.providers || {});
  const runtimeConfigProvider =
    options.runtimeConfigProvider || createNoopIapRuntimeConfigProvider();
  const getEntitlementsInternal = async (profileId) => {
    const [noAds, coins] = await Promise.all([
      store.getSubscription(profileId),
      store.getCoins(profileId)
    ]);
    return {
      profile_id: profileId,
      no_ads: normalizeSubscription(noAds),
      coins
    };
  };

  return {
    store,
    getEntitlements: async ({ profileId }) => {
      assertRequiredString(profileId, "profileId");
      return getEntitlementsInternal(profileId);
    },
    verifyPurchase: async ({
      profileId,
      provider,
      productId,
      payload,
      exportTarget,
      gameId
    }) => {
      assertRequiredString(profileId, "profileId");
      const normalizedGameId = normalizeGameId(
        gameId || (payload && payload.game_id) || ""
      );
      const runtimeConfig = normalizedGameId
        ? await runtimeConfigProvider.getIapRuntimeConfig({
            gameId: normalizedGameId
          })
        : null;
      const runtimeCatalog = normalizeObject(runtimeConfig?.iapCatalog);
      const catalog = mergeCatalog(baseCatalog, runtimeCatalog);
      const iapProviderConfigs = normalizeObject(runtimeConfig?.iapProviderConfigs);
      const normalized = await normalizePurchase({
        profileId,
        provider,
        productId,
        payload,
        catalog,
        exportTarget,
        providers,
        gameId: normalizedGameId,
        iapProviderConfigs
      });
      const dedupe = await store.recordTransaction(
        normalized.provider,
        normalized.externalTransactionId,
        {
          profileId,
          provider: normalized.provider,
          type: normalized.type,
          productId: normalized.productId,
          normalized
        }
      );

      if (!dedupe.isNew) {
        const entitlements = await getEntitlementsInternal(profileId);
        return {
          deduplicated: true,
          purchase: normalized,
          entitlements
        };
      }

      if (normalized.type === "consumable") {
        await store.addCoins(profileId, normalized.gameId, normalized.coinsDelta);
      } else if (normalized.subscription) {
        await store.upsertSubscription(profileId, normalized.subscription);
      }

      const entitlements = await getEntitlementsInternal(profileId);
      return {
        deduplicated: false,
        purchase: normalized,
        entitlements
      };
    },
    applyWebhookEvent: async ({ provider, body }) => {
      const normalizedBody = body && typeof body === "object" ? body : {};
      const profileId = String(normalizedBody.profile_id || "").trim();
      const productId = String(normalizedBody.product_id || "").trim();
      const exportTarget = String(normalizedBody.export_target || "").trim();
      if (!profileId || !productId) {
        throw new Error("webhook payload requires profile_id and product_id");
      }
      return this.verifyPurchase({
        profileId,
        provider,
        productId,
        exportTarget,
        gameId: normalizedBody.game_id || "",
        payload: normalizedBody.payload || normalizedBody
      });
    },
    mergeProfiles: async ({ primaryProfileId, secondaryProfileId }) => {
      assertRequiredString(primaryProfileId, "primaryProfileId");
      assertRequiredString(secondaryProfileId, "secondaryProfileId");
      return store.mergeProfiles(primaryProfileId, secondaryProfileId);
    },
    adjustCoins: async ({
      profileId,
      gameId,
      delta,
      reason,
      idempotencyKey
    }) => {
      assertRequiredString(profileId, "profileId");
      const normalizedGameId = String(gameId || "").trim().toLowerCase();
      if (!normalizedGameId) {
        throw new Error("gameId is required");
      }
      const deltaInt = Math.floor(Number(delta) || 0);
      if (deltaInt === 0) {
        throw new Error("delta must be non-zero");
      }
      const dedupeKey = String(idempotencyKey || "").trim();
      if (!dedupeKey) {
        throw new Error("idempotencyKey is required");
      }

      const tx = await store.recordTransaction("internal_coin_adjust", dedupeKey, {
        profileId,
        gameId: normalizedGameId,
        type: "coin_adjust",
        reason: String(reason || "").trim(),
        delta: deltaInt
      });
      if (!tx.isNew) {
        const entitlements = await getEntitlementsInternal(profileId);
        return {
          deduplicated: true,
          game_id: normalizedGameId,
          delta: deltaInt,
          entitlements
        };
      }

      if (deltaInt < 0) {
        const balances = await store.getCoins(profileId);
        const current = Number(balances?.[normalizedGameId]?.balance || 0);
        if (current + deltaInt < 0) {
          throw new Error("insufficient coins");
        }
      }
      await store.addCoins(profileId, normalizedGameId, deltaInt);
      const entitlements = await getEntitlementsInternal(profileId);
      return {
        deduplicated: false,
        game_id: normalizedGameId,
        delta: deltaInt,
        entitlements
      };
    }
  };
}

async function normalizePurchase(input) {
  const provider = normalizeProvider(input.provider);
  const productId = String(input.productId || "").trim().toLowerCase();
  if (!productId) {
    throw new Error("product_id is required");
  }
  const catalogEntry = resolveCatalogEntry(input.catalog, productId);
  if (!catalogEntry) {
    throw new Error("unknown product_id");
  }
  const expectedGameId = normalizeGameId(input.gameId || "");
  if (expectedGameId && catalogEntry.type === "consumable") {
    const catalogGameId = normalizeGameId(catalogEntry.gameId || "");
    if (catalogGameId && catalogGameId !== expectedGameId) {
      throw new Error("product_id does not belong to game_id");
    }
  }
  const target = normalizeExportTarget(input.exportTarget || input.payload?.export_target);
  enforceProviderForTarget(provider, target);
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const verified = await input.providers.verifyPurchase({
    provider,
    productId,
    payload,
    catalogEntry,
    nowSeconds: payload.now_seconds,
    providerConfig: resolveProviderConfig(input.iapProviderConfigs, provider),
    gameId: expectedGameId
  });
  if (!verified || typeof verified !== "object") {
    throw new Error("provider verification failed");
  }
  const externalTransactionId = String(
    verified.externalTransactionId ||
      payload.external_transaction_id ||
      payload.transaction_id ||
      payload.order_id ||
      payload.id ||
      createPayloadHash(provider, productId, payload)
  ).trim();
  if (!externalTransactionId) {
    throw new Error("missing external transaction id");
  }
  return {
    provider: verified.provider || provider,
    externalTransactionId,
    type: verified.type || catalogEntry.type,
    productId,
    gameId: verified.gameId || (catalogEntry.type === "consumable" ? catalogEntry.gameId : ""),
    coinsDelta:
      Number.isFinite(Number(verified.coinsDelta)) && Number(verified.coinsDelta) > 0
        ? Math.floor(Number(verified.coinsDelta))
        : 0,
    subscription: verified.subscription || null,
    exportTarget: target
  };
}

function mergeCatalog(baseCatalog, runtimeCatalog) {
  return {
    consumables: {
      ...normalizeCatalogSection(baseCatalog?.consumables),
      ...normalizeCatalogSection(runtimeCatalog?.consumables)
    },
    subscriptions: {
      ...normalizeCatalogSection(baseCatalog?.subscriptions),
      ...normalizeCatalogSection(runtimeCatalog?.subscriptions)
    }
  };
}

function normalizeCatalogSection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    if (!normalizedKey) {
      continue;
    }
    out[normalizedKey] = entry;
  }
  return out;
}

function resolveProviderConfig(configMap, provider) {
  if (!configMap || typeof configMap !== "object" || Array.isArray(configMap)) {
    return {};
  }
  const key = String(provider || "").trim().toLowerCase();
  const value = configMap[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeSubscription(sub) {
  const active = Boolean(sub?.active);
  const status = String(sub?.status || (active ? "active" : "none"));
  const expires = Number(sub?.expiresAt);
  if (Number.isFinite(expires) && expires > 0) {
    return {
      active,
      status,
      expires_at: Math.floor(expires)
    };
  }
  return {
    active,
    status
  };
}

function normalizeProvider(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("provider is required");
  }
  if (!["apple", "google", "paypal_web"].includes(normalized)) {
    throw new Error("unsupported provider");
  }
  return normalized;
}

function normalizeExportTarget(value) {
  const normalized = String(value || "web").trim().toLowerCase();
  if (!["ios", "android", "poki", "crazygames", "web"].includes(normalized)) {
    throw new Error("unsupported export_target");
  }
  return normalized;
}

function enforceProviderForTarget(provider, target) {
  const rules = {
    ios: ["apple"],
    android: ["google"],
    poki: ["paypal_web"],
    crazygames: ["paypal_web"],
    web: ["paypal_web"]
  };
  const allowed = rules[target] || [];
  if (!allowed.includes(provider)) {
    throw new Error(`provider ${provider} is not allowed for export_target ${target}`);
  }
}

function createPayloadHash(provider, productId, payload) {
  return crypto
    .createHash("sha256")
    .update(`${provider}:${productId}:${JSON.stringify(payload || {})}`)
    .digest("hex")
    .slice(0, 32);
}

function normalizeGameId(value) {
  return String(value || "").trim().toLowerCase();
}

function assertRequiredString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
}
