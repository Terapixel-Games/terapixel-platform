const DEFAULT_CATALOG = {
  consumables: {
    "coins_500_lumarush": {
      gameId: "lumarush",
      coins: 500,
      price: 0.99,
      currency: "USD"
    },
    "coins_1200_lumarush": {
      gameId: "lumarush",
      coins: 1200,
      price: 1.99,
      currency: "USD"
    },
    "coins_3000_lumarush": {
      gameId: "lumarush",
      coins: 3000,
      price: 4.99,
      currency: "USD"
    },
    "coins_7500_lumarush": {
      gameId: "lumarush",
      coins: 7500,
      price: 9.99,
      currency: "USD"
    },
    "coins_20000_lumarush": {
      gameId: "lumarush",
      coins: 20000,
      price: 19.99,
      currency: "USD"
    },
    "coins_500_color_crunch": {
      gameId: "color_crunch",
      coins: 500,
      price: 0.99,
      currency: "USD"
    },
    "coins_1200_color_crunch": {
      gameId: "color_crunch",
      coins: 1200,
      price: 1.99,
      currency: "USD"
    },
    "coins_3000_color_crunch": {
      gameId: "color_crunch",
      coins: 3000,
      price: 4.99,
      currency: "USD"
    },
    "coins_7500_color_crunch": {
      gameId: "color_crunch",
      coins: 7500,
      price: 9.99,
      currency: "USD"
    },
    "coins_20000_color_crunch": {
      gameId: "color_crunch",
      coins: 20000,
      price: 19.99,
      currency: "USD"
    }
  },
  subscriptions: {
    "no_ads_monthly": {
      entitlementKey: "no_ads",
      plan: "monthly"
    },
    "no_ads_yearly": {
      entitlementKey: "no_ads",
      plan: "yearly"
    }
  }
};

export function createCatalog(seed = {}) {
  const merged = {
    consumables: {
      ...DEFAULT_CATALOG.consumables,
      ...(seed.consumables || {})
    },
    subscriptions: {
      ...DEFAULT_CATALOG.subscriptions,
      ...(seed.subscriptions || {})
    }
  };
  return deepClone(merged);
}

export function resolveCatalogEntry(catalog, productId) {
  const key = String(productId || "").trim().toLowerCase();
  if (!key) {
    return null;
  }
  const consumable = catalog?.consumables?.[key];
  if (consumable) {
    return {
      type: "consumable",
      productId: key,
      ...consumable
    };
  }
  const sub = catalog?.subscriptions?.[key];
  if (sub) {
    return {
      type: "subscription",
      productId: key,
      ...sub
    };
  }
  return null;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
