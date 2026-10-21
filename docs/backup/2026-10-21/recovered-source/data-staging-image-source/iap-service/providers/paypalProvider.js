export function createPaypalWebProvider(options = {}) {
  const defaultClientId = String(options.clientId || "");
  const defaultClientSecret = String(options.clientSecret || "");
  const defaultBaseUrl =
    String(options.baseUrl || "").trim() || "https://api-m.paypal.com";

  return {
    verifyPurchase: async ({ provider, payload, catalogEntry, nowSeconds, providerConfig }) => {
      const orderId = String(payload?.order_id || payload?.orderId || "").trim();
      if (!orderId) {
        throw new Error("paypal payload.order_id is required");
      }
      const effectiveClientId = String(providerConfig?.clientId || defaultClientId).trim();
      const effectiveClientSecret = String(
        providerConfig?.clientSecret || defaultClientSecret
      ).trim();
      const effectiveBaseUrl =
        String(providerConfig?.baseUrl || defaultBaseUrl).trim() ||
        "https://api-m.paypal.com";
      if (!effectiveClientId || !effectiveClientSecret) {
        throw new Error("paypal credentials are not configured");
      }
      const token = await getPaypalAccessToken(
        `${effectiveBaseUrl}/v1/oauth2/token`,
        effectiveClientId,
        effectiveClientSecret
      );
      const order = await getJson(
        `${effectiveBaseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
        token
      );
      const status = String(order?.status || "").toUpperCase();
      if (!["COMPLETED", "APPROVED"].includes(status)) {
        throw new Error(`paypal order not complete (status=${status || "unknown"})`);
      }
      assertOrderMatchesCatalog(order, catalogEntry);

      if (catalogEntry.type === "consumable") {
        return {
          provider,
          externalTransactionId: orderId,
          type: "consumable",
          gameId: catalogEntry.gameId,
          coinsDelta: Number(catalogEntry.coins) || 0,
          subscription: null
        };
      }
      const expiresAt = Number(payload?.expires_at || 0);
      const now = normalizeNow(nowSeconds);
      const active = Number.isFinite(expiresAt) ? expiresAt > now : true;
      return {
        provider,
        externalTransactionId: orderId,
        type: "subscription",
        gameId: "",
        coinsDelta: 0,
        subscription: {
          provider,
          externalSubscriptionId: orderId,
          status: active ? "active" : "expired",
          active,
          expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? Math.floor(expiresAt) : undefined
        }
      };
    }
  };
}

function assertOrderMatchesCatalog(order, catalogEntry) {
  const expectedPrice = Number(catalogEntry?.price || 0);
  const expectedCurrency = String(catalogEntry?.currency || "").trim().toUpperCase();
  const unit = order?.purchase_units?.[0] || {};
  const amount = unit?.amount || {};
  const orderValue = Number(amount?.value || 0);
  const orderCurrency = String(amount?.currency_code || "").trim().toUpperCase();

  if (expectedCurrency && orderCurrency && expectedCurrency !== orderCurrency) {
    throw new Error(
      `paypal currency mismatch (expected=${expectedCurrency}, actual=${orderCurrency})`
    );
  }

  if (expectedPrice > 0 && Number.isFinite(orderValue)) {
    const delta = Math.abs(expectedPrice - orderValue);
    if (delta > 0.01) {
      throw new Error(
        `paypal amount mismatch (expected=${expectedPrice.toFixed(2)}, actual=${orderValue.toFixed(2)})`
      );
    }
  }
}

async function getPaypalAccessToken(tokenUrl, clientId, clientSecret) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(`paypal token request failed (${response.status})`);
  }
  return String(json.access_token);
}

async function getJson(url, accessToken) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`paypal verify failed (${response.status})`);
  }
  return json;
}

function normalizeNow(nowSeconds) {
  if (Number.isFinite(Number(nowSeconds)) && Number(nowSeconds) > 0) {
    return Math.floor(Number(nowSeconds));
  }
  return Math.floor(Date.now() / 1000);
}
