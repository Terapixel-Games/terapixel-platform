export function createPaypalWebProvider(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const defaultClientId = String(options.clientId || "");
  const defaultClientSecret = String(options.clientSecret || "");
  const defaultBaseUrl =
    String(options.baseUrl || "").trim() || "https://api-m.paypal.com";

  return {
    verifyPurchase: async ({ provider, payload, catalogEntry, providerConfig }) => {
      if (catalogEntry?.type !== "consumable") {
        throw new Error("PayPal subscription verification is not supported");
      }
      const rawOrderId = payload?.order_id || payload?.orderId;
      const orderId = typeof rawOrderId === "string" ? rawOrderId.trim() : "";
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
        effectiveClientSecret,
        fetchImpl
      );
      const order = await getJson(
        `${effectiveBaseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
        token,
        fetchImpl
      );
      const status = String(order?.status || "").toUpperCase();
      if (status !== "COMPLETED") {
        throw new Error(`paypal order not complete (status=${status || "unknown"})`);
      }
      if (order.id !== orderId) throw new Error("paypal order ID mismatch");
      assertOrderMatchesCatalog(order, catalogEntry);

      return {
        provider,
        externalTransactionId: orderId,
        type: "consumable",
        gameId: catalogEntry.gameId,
        coinsDelta: Number(catalogEntry.coins) || 0,
        subscription: null
      };
    }
  };
}

function assertOrderMatchesCatalog(order, catalogEntry) {
  const units = order.purchase_units;
  if (!Array.isArray(units) || units.length !== 1) {
    throw new Error("paypal requires one fully captured purchase unit");
  }
  const captures = units[0]?.payments?.captures;
  if (!Array.isArray(captures) || captures.length !== 1 ||
      !captures[0]?.id || captures[0].status !== "COMPLETED") {
    throw new Error("paypal completed capture is required");
  }
  assertAmount(units[0].amount, catalogEntry);
  assertAmount(captures[0].amount, catalogEntry);
}

function assertAmount(amount, catalogEntry) {
  const expected = Number(catalogEntry.price);
  const currency = String(catalogEntry.currency || "").trim().toUpperCase();
  const value = amount?.value;
  if (!Number.isFinite(expected) || expected <= 0 || !currency ||
      typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value) ||
      amount.currency_code !== currency ||
      Math.round(Number(value) * 100) !== Math.round(expected * 100)) {
    throw new Error("paypal captured amount/currency does not match catalog");
  }
}

async function getPaypalAccessToken(tokenUrl, clientId, clientSecret, fetchImpl) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetchImpl(tokenUrl, {
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

async function getJson(url, accessToken, fetchImpl) {
  const response = await fetchImpl(url, {
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
