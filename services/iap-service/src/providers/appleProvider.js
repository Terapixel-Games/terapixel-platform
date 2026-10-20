export function createAppleProvider(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const sharedSecret = String(options.sharedSecret || "");
  const productionUrl =
    String(options.productionUrl || "").trim() ||
    "https://buy.itunes.apple.com/verifyReceipt";
  const sandboxUrl =
    String(options.sandboxUrl || "").trim() ||
    "https://sandbox.itunes.apple.com/verifyReceipt";

  return {
    verifyPurchase: async ({ provider, productId, payload, catalogEntry, nowSeconds }) => {
      const rawReceipt = payload?.receipt_data || payload?.receiptData;
      const receiptData = typeof rawReceipt === "string" ? rawReceipt.trim() : "";
      if (!receiptData) {
        throw new Error("apple payload.receipt_data is required");
      }
      const requestBody = {
        "receipt-data": receiptData,
        password: sharedSecret || undefined,
        "exclude-old-transactions": true
      };
      let response = await postJson(productionUrl, requestBody, fetchImpl);
      // Apple status 21007 means sandbox receipt sent to production.
      if (Number(response?.status) === 21007) {
        response = await postJson(sandboxUrl, requestBody, fetchImpl);
      }
      if (Number(response?.status) !== 0) {
        throw new Error(`apple receipt rejected (status=${response?.status})`);
      }
      const line = pickAppleReceiptLine(response, productId);
      if (!line) {
        throw new Error("apple receipt missing matching product");
      }
      const externalTransactionId = String(
        line.transaction_id || line.original_transaction_id || ""
      ).trim();
      if (!externalTransactionId) {
        throw new Error("apple receipt missing transaction id");
      }
      const now = normalizeNow(nowSeconds);
      if (catalogEntry.type === "consumable") {
        return {
          provider,
          externalTransactionId,
          type: "consumable",
          gameId: catalogEntry.gameId,
          coinsDelta: Number(catalogEntry.coins) || 0,
          subscription: null
        };
      }
      const expiresAt = Math.floor(Number(line.expires_date_ms || 0) / 1000);
      if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
        throw new Error("apple subscription missing valid expiry");
      }
      const active = expiresAt > now;
      return {
        provider,
        externalTransactionId,
        type: "subscription",
        gameId: "",
        coinsDelta: 0,
        subscription: {
          provider,
          externalSubscriptionId: String(line.original_transaction_id || externalTransactionId),
          status: active ? "active" : "expired",
          active,
          expiresAt: expiresAt > 0 ? expiresAt : undefined
        }
      };
    }
  };
}

function pickAppleReceiptLine(response, productId) {
  const latest = Array.isArray(response?.latest_receipt_info)
    ? response.latest_receipt_info
    : [];
  const inApp = Array.isArray(response?.receipt?.in_app) ? response.receipt.in_app : [];
  const merged = [...latest, ...inApp];
  const target = String(productId || "").trim().toLowerCase();
  merged.sort((a, b) =>
    Number(b?.expires_date_ms || b?.purchase_date_ms || 0) -
    Number(a?.expires_date_ms || a?.purchase_date_ms || 0)
  );
  for (const row of merged) {
    if (!row || typeof row !== "object") {
      continue;
    }
    if (String(row.product_id || "").trim().toLowerCase() === target) {
      return row;
    }
  }
  return null;
}

async function postJson(url, body, fetchImpl) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body || {})
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`apple verify failed (${response.status})`);
  }
  return json;
}

function normalizeNow(nowSeconds) {
  if (Number.isFinite(Number(nowSeconds)) && Number(nowSeconds) > 0) {
    return Math.floor(Number(nowSeconds));
  }
  return Math.floor(Date.now() / 1000);
}
