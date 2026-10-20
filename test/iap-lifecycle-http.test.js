import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createIapService, createIapHttpServer } from "../services/iap-service/index.js";
import { createSessionToken } from "../packages/shared-utils/index.js";
const now = 1_800_000_000;
async function withServer(run) {
  let clock = now;
  let orderStatus = "APPROVED";
  const secret = "test-iap-http-session-secret";
  const service = createIapService({ clock: () => clock, providers: {
    apple: { fetch: async () => new Response(JSON.stringify({ status: 0, latest_receipt_info: [{ product_id: "no_ads_monthly", transaction_id: "receipt-tx", expires_date_ms: String((now + 1) * 1000) }] })) },
    paypal: { clientId: "test-client", clientSecret: "test-secret", fetch: async (url) => new Response(JSON.stringify(url.endsWith("/token") ? { access_token: "test-token" } : {
      id: "ORDER-1", status: orderStatus, purchase_units: [{ amount: { value: "0.99", currency_code: "USD" }, payments: { captures: [{ id: "CAPTURE-1", status: "COMPLETED", amount: { value: "0.99", currency_code: "USD" } }] } }]
    })) }
  } });
  const server = createIapHttpServer({ service, sessionSecret: secret });
  const { baseUrl } = await server.listen();
  const token = createSessionToken({ sub: "player" }, secret, { ttlSeconds: 600 });
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const post = (path, body, extra = {}) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try { await run({ baseUrl, service, post, headers, advance: () => clock++, capture: () => { orderStatus = "COMPLETED"; } }); }
  finally { await server.close(); }
}
describe("IAP lifecycle routes", () => {
  it("uses server expiry on verification/read despite request time and expiry fields", () => withServer(async ({ baseUrl, post, headers, advance }) => {
    const request = { provider: "apple", product_id: "no_ads_monthly", export_target: "ios", nowSeconds: 1, payload: { receipt_data: "test-receipt", now_seconds: 1, expires_at: now + 999999 } };
    const response = await post("/v1/iap/verify", request);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).entitlements.no_ads.active, true);
    advance();
    const read = await fetch(`${baseUrl}/v1/iap/entitlements?now_seconds=1`, { headers });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).no_ads.active, false);
    const retry = await post("/v1/iap/verify", request);
    assert.equal(retry.status, 200);
    const result = await retry.json();
    assert.equal(result.deduplicated, true);
    assert.equal(result.entitlements.no_ads.active, false);
  }));
  it("rejects approved-but-uncaptured PayPal without consuming the order key", () => withServer(async ({ post, capture, service }) => {
    const request = { provider: "paypal_web", product_id: "coins_500_lumarush", export_target: "web", payload: { order_id: "ORDER-1" } };
    const denied = await post("/v1/iap/verify", request);
    assert.equal(denied.status, 422);
    assert.equal((await denied.json()).error.code, "purchase_rejected");
    assert.equal(service.store._transactions.size, 0);
    capture();
    const granted = await post("/v1/iap/verify", request);
    assert.equal(granted.status, 200);
    const result = await granted.json();
    assert.equal(result.deduplicated, false);
    assert.equal(result.entitlements.coins.lumarush.balance, 500);
  }));
  it("rejects client-supplied PayPal subscription expiry", () => withServer(async ({ post, service }) => {
    const response = await post("/v1/iap/verify", { provider: "paypal_web", product_id: "no_ads_monthly", payload: { order_id: "ORDER-1", expires_at: now + 999999 } });
    assert.equal(response.status, 422);
    assert.equal(service.store._transactions.size, 0);
  }));
  it("fails closed for unsigned, signature-looking and native-envelope webhook bodies", () => withServer(async ({ post, service }) => {
    for (const provider of ["apple", "google", "paypal"]) {
      for (const body of [
        { profile_id: "victim", product_id: "coins_500_lumarush", payload: { transaction_id: "forged" } },
        { signedPayload: "not-a-valid-jws", message: { data: "not-a-valid-pubsub-payload" }, event_type: "PAYMENT.CAPTURE.COMPLETED" }
      ]) {
        const response = await post(`/v1/iap/webhook/${provider}`, body, { "paypal-transmission-sig": "invalid-signature", authorization: "Bearer invalid-push-jwt" });
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error.code, "webhook_not_configured");
      }
    }
    assert.equal(service.store._transactions.size, 0);
    const { applyWebhookEvent } = service;
    await assert.rejects(applyWebhookEvent({ provider: "apple", body: {} }), { name: "WebhookUnavailableError" });
  }));
  it("rejects malformed JSON/request/payload objects without grants", () => withServer(async ({ post, baseUrl, headers, service }) => {
    for (const body of [null, [], {}, { provider: 42, product_id: "no_ads_monthly", payload: {} }, { provider: "apple", product_id: "no_ads_monthly", payload: [] }]) {
      assert.equal((await post("/v1/iap/verify", body)).status, 400);
    }
    assert.equal((await fetch(`${baseUrl}/v1/iap/webhook/apple`, { method: "POST", headers, body: "{" })).status, 400);
    assert.equal((await post("/v1/iap/webhook/google", [])).status, 400);
    assert.equal(service.store._transactions.size, 0);
  }));
});
