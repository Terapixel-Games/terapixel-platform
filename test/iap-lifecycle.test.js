import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createIapService, InMemoryIapStore } from "../services/iap-service/index.js";
import { createAppleProvider } from "../services/iap-service/src/providers/appleProvider.js";
import { createGooglePlayProvider } from "../services/iap-service/src/providers/googleProvider.js";
import { createPaypalWebProvider } from "../services/iap-service/src/providers/paypalProvider.js";

const now = 1_800_000_000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const subRequest = { profileId: "player", provider: "apple", productId: "no_ads_monthly", exportTarget: "ios", payload: { receipt_data: "test-receipt", now_seconds: 1, expires_at: 9_000_000_000 } };
function appleService(reply, clock = () => now) {
  return createIapService({ clock, providers: { apple: { fetch: async () => json(reply) } } });
}
const receipt = (expires, product = "no_ads_monthly", id = "apple-tx") => ({ status: 0, latest_receipt_info: [{ product_id: product, transaction_id: id, original_transaction_id: "apple-sub", expires_date_ms: String(expires * 1000) }] });

function paypalService(order, onFetch = () => {}) {
  return createIapService({ clock: () => now, providers: { paypal: {
    clientId: "test-client", clientSecret: "test-client-secret",
    fetch: async (url) => {
      onFetch(url);
      return url.endsWith("/token") ? json({ access_token: "test-access-token" }) : json(order);
    }
  } } });
}
const paypalRequest = { profileId: "player", provider: "paypal_web", productId: "coins_500_lumarush", exportTarget: "web", payload: { order_id: "ORDER-1" } };
const completedOrder = () => ({ id: "ORDER-1", status: "COMPLETED", purchase_units: [{ amount: { value: "0.99", currency_code: "USD" }, payments: { captures: [{ id: "CAPTURE-1", status: "COMPLETED", amount: { value: "0.99", currency_code: "USD" } }] } }] });

describe("server-time subscription lifecycle", () => {
  for (const [offset, active] of [[1, true], [0, false], [-1, false]]) {
    it(`Apple receipt at expiry offset ${offset} ignores client clock/expiry`, async () => {
      const service = appleService(receipt(now + offset));
      const result = await service.verifyPurchase({ ...subRequest, nowSeconds: 1 });
      assert.equal(result.entitlements.no_ads.active, active);
      assert.equal(result.entitlements.no_ads.expires_at, now + offset);
    });
  }

  it("rechecks expiry on reads and on a deduplicated verification", async () => {
    let clock = now;
    const service = appleService(receipt(now + 5), () => clock);
    assert.equal((await service.verifyPurchase(subRequest)).entitlements.no_ads.active, true);
    clock += 5;
    assert.deepEqual((await service.getEntitlements({ profileId: "player", nowSeconds: 1 })).no_ads, { active: false, status: "expired", expires_at: now + 5 });
    const retry = await service.verifyPurchase(subRequest);
    assert.equal(retry.deduplicated, true);
    assert.equal(retry.entitlements.no_ads.active, false);
  });

  it("uses latest matching Apple line and never falls back to another product", async () => {
    const reply = receipt(now - 10);
    reply.latest_receipt_info.push(receipt(now + 100, "no_ads_monthly", "renewed-tx").latest_receipt_info[0]);
    assert.equal((await appleService(reply).verifyPurchase(subRequest)).entitlements.no_ads.active, true);
    await assert.rejects(appleService(receipt(now + 100, "different-product")).verifyPurchase(subRequest), /matching product/);
  });

  it("rejects malformed verified expiry and receipt payload before entitlement grant", async () => {
    const service = appleService(receipt(NaN));
    await assert.rejects(service.verifyPurchase(subRequest), /valid expiry/);
    assert.equal((await service.getEntitlements({ profileId: "player" })).no_ads.active, false);
    for (const receipt_data of [undefined, {}, 42, " "]) {
      await assert.rejects(appleService({}).verifyPurchase({ ...subRequest, payload: { receipt_data } }), /receipt_data is required/);
    }
  });

  it("never grants indefinite or malformed stored subscriptions", async () => {
    for (const expiresAt of [undefined, 0, NaN, Infinity, "bad", now - 1]) {
      const store = new InMemoryIapStore();
      await store.upsertSubscription("player", { active: true, status: "active", expiresAt });
      const service = createIapService({ store, clock: () => now });
      assert.equal((await service.getEntitlements({ profileId: "player" })).no_ads.active, false);
    }
  });

  it("passes only construction-owned time to provider verification", async () => {
    let received;
    const service = createIapService({ clock: () => now, providerRegistry: { verifyPurchase: async (input) => {
      received = input.nowSeconds;
      return { provider: "apple", type: "subscription", externalTransactionId: "tx", subscription: { active: true, status: "active", expiresAt: now + 10 } };
    } } });
    await service.verifyPurchase({ ...subRequest, nowSeconds: 1 });
    assert.equal(received, now);
  });
});

describe("PayPal captured-payment verification", () => {
  it("grants a completed captured payment once, preserving order-ID deduplication", async () => {
    const service = paypalService(completedOrder());
    const first = await service.verifyPurchase(paypalRequest);
    const again = await service.verifyPurchase(paypalRequest);
    assert.equal(first.purchase.externalTransactionId, "ORDER-1");
    assert.equal(first.entitlements.coins.lumarush.balance, 500);
    assert.equal(again.deduplicated, true);
    assert.equal(again.entitlements.coins.lumarush.balance, 500);
  });

  for (const status of ["APPROVED", "CREATED", "PAYER_ACTION_REQUIRED", "", undefined]) {
    it(`rejects uncaptured order status ${status}`, async () => {
      const order = completedOrder(); order.status = status;
      const service = paypalService(order);
      await assert.rejects(service.verifyPurchase(paypalRequest), /order not complete/);
      assert.deepEqual((await service.getEntitlements({ profileId: "player" })).coins, {});
    });
  }

  it("rejects missing/pending captures, mismatched order and incomplete amount data", async () => {
    const changes = [
      (o) => { delete o.purchase_units[0].payments; },
      (o) => { o.purchase_units[0].payments.captures[0].status = "PENDING"; },
      (o) => { o.id = "OTHER"; },
      (o) => { o.purchase_units[0].payments.captures[0].amount.value = "0.98"; },
      (o) => { delete o.purchase_units[0].payments.captures[0].amount.currency_code; },
      (o) => { o.purchase_units[0].amount.value = "NaN"; },
      (o) => { o.purchase_units.push(o.purchase_units[0]); }
    ];
    for (const change of changes) {
      const order = completedOrder(); change(order);
      await assert.rejects(paypalService(order).verifyPurchase(paypalRequest), /paypal/);
    }
  });

  it("rejects subscription Orders payloads regardless of client expiry, before network", async () => {
    let requests = 0;
    const service = paypalService(completedOrder(), () => requests++);
    await assert.rejects(service.verifyPurchase({ ...paypalRequest, productId: "no_ads_monthly", payload: { order_id: "ORDER-1", expires_at: now + 1_000_000, now_seconds: 1 } }), /subscription verification is not supported/);
    assert.equal(requests, 0);
  });

  it("rejects malformed order IDs and unconfigured credentials", async () => {
    const provider = createPaypalWebProvider({ fetch: () => { throw new Error("unexpected network"); } });
    for (const order_id of [undefined, 42, {}, " "]) {
      await assert.rejects(provider.verifyPurchase({ payload: { order_id }, catalogEntry: { type: "consumable" } }), /order_id is required/);
    }
    await assert.rejects(provider.verifyPurchase({ payload: { order_id: "ORDER-1" }, catalogEntry: { type: "consumable" } }), /credentials are not configured/);
  });
});

describe("Google verified subscription response (mocked OAuth and publisher API)", () => {
  function serviceFor(t, subscription) {
    // No credentials or signing keys are generated; OAuth signatures and HTTP
    // responses are test doubles, not evidence of live Google verification.
    t.mock.method(crypto, "createSign", () => ({ update() {}, end() {}, sign() { return Buffer.from("test-signature"); } }));
    return createIapService({ clock: () => now, providers: { google: {
      clientEmail: "test@example.invalid", privateKey: "test-key-placeholder",
      fetch: async (url) => url.includes("oauth2") ? json({ access_token: "test-token" }) : json(subscription)
    } } });
  }
  const request = { profileId: "player", provider: "google", productId: "no_ads_monthly", exportTarget: "android", payload: { package_name: "test.game", purchase_token: "test-purchase", now_seconds: 1, expires_at: now + 99999 } };
  const sub = (state, offset = 10, productId = "no_ads_monthly") => ({ latestOrderId: "google-order", subscriptionState: state, lineItems: [{ productId, expiryTime: new Date((now + offset) * 1000).toISOString() }] });
  for (const [state, active] of [["ACTIVE", true], ["CANCELED", true], ["IN_GRACE_PERIOD", true], ["ON_HOLD", false], ["PAUSED", false], ["PENDING", false]]) {
    it(`handles verified state ${state}`, async (t) => {
      const service = serviceFor(t, sub(`SUBSCRIPTION_STATE_${state}`));
      assert.equal((await service.verifyPurchase(request)).entitlements.no_ads.active, active);
    });
  }
  it("expires exactly at the server boundary despite client clock override", async (t) => {
    const service = serviceFor(t, sub("SUBSCRIPTION_STATE_ACTIVE", 0));
    assert.equal((await service.verifyPurchase(request)).entitlements.no_ads.active, false);
  });
  it("rejects missing state, wrong product and malformed expiry", async (t) => {
    for (const reply of [sub("", 10), sub("SUBSCRIPTION_STATE_ACTIVE", 10, "other"), { ...sub("SUBSCRIPTION_STATE_ACTIVE"), lineItems: [{ productId: "no_ads_monthly", expiryTime: "bad" }] }]) {
      await assert.rejects(serviceFor(t, reply).verifyPurchase(request), /google subscription missing/);
    }
  });
});
