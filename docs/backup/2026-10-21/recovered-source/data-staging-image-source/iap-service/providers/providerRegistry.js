import { createAppleProvider } from "./appleProvider.js";
import { createGooglePlayProvider } from "./googleProvider.js";
import { createPaypalWebProvider } from "./paypalProvider.js";

export function createProviderRegistry(options = {}) {
  const apple = createAppleProvider(options.apple || {});
  const google = createGooglePlayProvider(options.google || {});
  const paypal = createPaypalWebProvider(options.paypal || {});
  return {
    verifyPurchase: async ({
      provider,
      productId,
      payload,
      catalogEntry,
      nowSeconds,
      providerConfig,
      gameId
    }) => {
      const normalizedProvider = String(provider || "").trim().toLowerCase();
      if (normalizedProvider === "apple") {
        return apple.verifyPurchase({
          provider: normalizedProvider,
          productId,
          payload,
          catalogEntry,
          nowSeconds,
          providerConfig,
          gameId
        });
      }
      if (normalizedProvider === "google") {
        return google.verifyPurchase({
          provider: normalizedProvider,
          productId,
          payload,
          catalogEntry,
          nowSeconds,
          providerConfig,
          gameId
        });
      }
      if (normalizedProvider === "paypal_web") {
        return paypal.verifyPurchase({
          provider: normalizedProvider,
          productId,
          payload,
          catalogEntry,
          nowSeconds,
          providerConfig,
          gameId
        });
      }
      throw new Error("unsupported provider");
    }
  };
}
