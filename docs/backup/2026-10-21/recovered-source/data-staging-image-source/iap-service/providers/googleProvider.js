import crypto from "node:crypto";

export function createGooglePlayProvider(options = {}) {
  const clientEmail = String(options.clientEmail || "");
  const privateKey = normalizePrivateKey(options.privateKey || "");
  const tokenUrl =
    String(options.tokenUrl || "").trim() || "https://oauth2.googleapis.com/token";
  const apiBase =
    String(options.apiBase || "").trim() ||
    "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
  const scope = "https://www.googleapis.com/auth/androidpublisher";

  return {
    verifyPurchase: async ({ provider, productId, payload, catalogEntry, nowSeconds }) => {
      const packageName = String(payload?.package_name || payload?.packageName || "").trim();
      const purchaseToken = String(
        payload?.purchase_token || payload?.purchaseToken || ""
      ).trim();
      if (!packageName || !purchaseToken) {
        throw new Error("google payload.package_name and payload.purchase_token are required");
      }
      if (!clientEmail || !privateKey) {
        throw new Error("google provider credentials are not configured");
      }
      const accessToken = await createGoogleAccessToken({
        clientEmail,
        privateKey,
        tokenUrl,
        scope
      });

      if (catalogEntry.type === "consumable") {
        const url = `${apiBase}/${encodeURIComponent(
          packageName
        )}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(
          purchaseToken
        )}`;
        const purchase = await getJson(url, accessToken);
        const state = Number(purchase.purchaseState || 0);
        if (state !== 0) {
          throw new Error(`google purchase not completed (purchaseState=${state})`);
        }
        return {
          provider,
          externalTransactionId: String(
            purchase.orderId || purchaseToken
          ).trim(),
          type: "consumable",
          gameId: catalogEntry.gameId,
          coinsDelta: Number(catalogEntry.coins) || 0,
          subscription: null
        };
      }

      const url = `${apiBase}/${encodeURIComponent(
        packageName
      )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
      const sub = await getJson(url, accessToken);
      const latestLine = Array.isArray(sub.lineItems) ? sub.lineItems[0] || {} : {};
      const expiry = Date.parse(String(latestLine.expiryTime || ""));
      const expiresAt = Number.isFinite(expiry) ? Math.floor(expiry / 1000) : 0;
      const now = normalizeNow(nowSeconds);
      const active = expiresAt > now;
      return {
        provider,
        externalTransactionId: String(
          sub.latestOrderId || purchaseToken
        ).trim(),
        type: "subscription",
        gameId: "",
        coinsDelta: 0,
        subscription: {
          provider,
          externalSubscriptionId: String(sub.latestOrderId || purchaseToken),
          status: active ? "active" : "expired",
          active,
          expiresAt: expiresAt > 0 ? expiresAt : undefined
        }
      };
    }
  };
}

async function createGoogleAccessToken(config) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = signServiceAccountJwt({
    clientEmail: config.clientEmail,
    privateKey: config.privateKey,
    scope: config.scope,
    tokenUrl: config.tokenUrl,
    now
  });
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(`google token request failed (${response.status})`);
  }
  return String(json.access_token);
}

function signServiceAccountJwt(input) {
  const header = base64UrlEncode(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  );
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: input.clientEmail,
      scope: input.scope,
      aud: input.tokenUrl,
      iat: input.now,
      exp: input.now + 3600
    })
  );
  const unsigned = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(input.privateKey);
  return `${unsigned}.${base64UrlBuffer(signature)}`;
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
    throw new Error(`google verify failed (${response.status})`);
  }
  return json;
}

function base64UrlEncode(value) {
  return base64UrlBuffer(Buffer.from(value));
}

function base64UrlBuffer(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n");
}

function normalizeNow(nowSeconds) {
  if (Number.isFinite(Number(nowSeconds)) && Number(nowSeconds) > 0) {
    return Math.floor(Number(nowSeconds));
  }
  return Math.floor(Date.now() / 1000);
}
