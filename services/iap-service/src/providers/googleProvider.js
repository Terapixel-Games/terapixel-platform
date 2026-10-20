import crypto from "node:crypto";

export function createGooglePlayProvider(options = {}) {
  const fetchImpl = options.fetch || fetch;
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
      const rawPackage = payload?.package_name || payload?.packageName;
      const rawToken = payload?.purchase_token || payload?.purchaseToken;
      const packageName = typeof rawPackage === "string" ? rawPackage.trim() : "";
      const purchaseToken = typeof rawToken === "string" ? rawToken.trim() : "";
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
        scope,
        fetchImpl
      });

      if (catalogEntry.type === "consumable") {
        const url = `${apiBase}/${encodeURIComponent(
          packageName
        )}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(
          purchaseToken
        )}`;
        const purchase = await getJson(url, accessToken, fetchImpl);
        const state = purchase.purchaseState;
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
      const sub = await getJson(url, accessToken, fetchImpl);
      const lines = Array.isArray(sub.lineItems)
        ? sub.lineItems.filter((line) => line?.productId === productId)
        : [];
      lines.sort((a, b) => Date.parse(b.expiryTime) - Date.parse(a.expiryTime));
      const latestLine = lines[0];
      if (!latestLine) throw new Error("google subscription missing matching product");
      const expiry = Date.parse(String(latestLine.expiryTime || ""));
      const expiresAt = Number.isFinite(expiry) ? Math.floor(expiry / 1000) : 0;
      if (expiresAt <= 0) throw new Error("google subscription missing valid expiry");
      const now = normalizeNow(nowSeconds);
      const state = String(sub.subscriptionState || "");
      if (!state || state === "SUBSCRIPTION_STATE_UNSPECIFIED") {
        throw new Error("google subscription missing state");
      }
      const entitledStates = ["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "SUBSCRIPTION_STATE_CANCELED"];
      const active = entitledStates.includes(state) && expiresAt > now;
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
          status: expiresAt <= now ? "expired" : state.replace("SUBSCRIPTION_STATE_", "").toLowerCase(),
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
  const response = await config.fetchImpl(config.tokenUrl, {
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

async function getJson(url, accessToken, fetchImpl) {
  const response = await fetchImpl(url, {
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
