import {
  createDefaultSaveEnvelope,
  mergeSaveEnvelopes,
  validateSaveEnvelope
} from "./saveEnvelope.js";
import { InMemorySaveStore } from "./saveStore.js";
import { createNoopRuntimeConfigProvider } from "../../../packages/shared-utils/index.js";

export function createSaveService(options = {}) {
  const saveStore = options.saveStore || new InMemorySaveStore();
  const runtimeConfigProvider =
    options.runtimeConfigProvider || createNoopRuntimeConfigProvider();
  const runtimeConfigRequired = options.runtimeConfigRequired === true;

  return {
    saveStore,
    getServerEnvelope: async ({ gameId, profileId }) => {
      assertRequiredString(gameId, "gameId");
      assertRequiredString(profileId, "profileId");
      await assertGameConfigured({
        gameId,
        runtimeConfigProvider,
        runtimeConfigRequired
      });
      return saveStore.get(gameId, profileId);
    },
    syncSave: async ({ gameId, profileId, clientEnvelope, nowSeconds }) => {
      assertRequiredString(gameId, "gameId");
      assertRequiredString(profileId, "profileId");
      await assertGameConfigured({
        gameId,
        runtimeConfigProvider,
        runtimeConfigRequired
      });
      const now = normalizeNow(nowSeconds);

      const serverEnvelope = await saveStore.get(gameId, profileId);
      if (!clientEnvelope && serverEnvelope) {
        return {
          envelope: serverEnvelope,
          source: "server"
        };
      }

      if (!clientEnvelope && !serverEnvelope) {
        const created = createDefaultSaveEnvelope({
          gameId,
          profileId,
          updatedAt: now
        });
        const persisted = await saveStore.put(created);
        return {
          envelope: persisted,
          source: "created_default"
        };
      }

      if (clientEnvelope) {
        validateSaveEnvelope(clientEnvelope);
        assertEnvelopeIdentity(clientEnvelope, gameId, profileId);
      }

      if (!serverEnvelope && clientEnvelope) {
        const firstWrite = {
          ...clientEnvelope,
          updated_at: Math.max(Number(clientEnvelope.updated_at) || 0, now),
          revision: Math.max(1, Number(clientEnvelope.revision) || 1)
        };
        const persisted = await saveStore.put(firstWrite);
        return {
          envelope: persisted,
          source: "client_first_write"
        };
      }

      const merged = mergeSaveEnvelopes(clientEnvelope, serverEnvelope, {
        nowSeconds: now
      });
      const persisted = await saveStore.put(merged);
      return {
        envelope: persisted,
        source: "merged"
      };
    },
    mergeProfiles: async ({ primaryProfileId, secondaryProfileId, nowSeconds }) => {
      assertRequiredString(primaryProfileId, "primaryProfileId");
      assertRequiredString(secondaryProfileId, "secondaryProfileId");
      if (primaryProfileId === secondaryProfileId) {
        return { merged: false, affected_games: [] };
      }
      const now = normalizeNow(nowSeconds);
      const secondaryRows = await listByProfile(saveStore, secondaryProfileId);
      const affectedGames = [];
      for (const secondaryEnvelope of secondaryRows) {
        const gameId = String(secondaryEnvelope.game_id || "");
        if (!gameId) {
          continue;
        }
        const primaryEnvelope = await saveStore.get(gameId, primaryProfileId);
        const secondaryAsPrimary = {
          ...secondaryEnvelope,
          profile_id: primaryProfileId
        };
        const merged = primaryEnvelope
          ? mergeSaveEnvelopes(secondaryAsPrimary, primaryEnvelope, {
              nowSeconds: now
            })
          : {
              ...secondaryAsPrimary,
              revision: Math.max(1, Number(secondaryAsPrimary.revision) || 1),
              updated_at: Math.max(now, Number(secondaryAsPrimary.updated_at) || 0)
            };
        await saveStore.put(merged);
        await deleteByGameAndProfile(saveStore, gameId, secondaryProfileId);
        affectedGames.push(gameId);
      }
      return {
        merged: true,
        affected_games: affectedGames
      };
    }
  };
}

async function assertGameConfigured(input = {}) {
  if (!input.runtimeConfigRequired) {
    return;
  }
  const runtimeConfig = await input.runtimeConfigProvider.getRuntimeConfig({
    gameId: input.gameId
  });
  if (!runtimeConfig) {
    throw new Error("game_id is not onboarded or is inactive");
  }
}

function assertRequiredString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
}

function normalizeNow(nowSeconds) {
  if (Number.isFinite(Number(nowSeconds)) && Number(nowSeconds) > 0) {
    return Math.floor(Number(nowSeconds));
  }
  return Math.floor(Date.now() / 1000);
}

function assertEnvelopeIdentity(envelope, gameId, profileId) {
  if (envelope.game_id !== gameId) {
    throw new Error("client envelope game_id mismatch");
  }
  if (envelope.profile_id !== profileId) {
    throw new Error("client envelope profile_id mismatch");
  }
}

async function listByProfile(saveStore, profileId) {
  if (typeof saveStore.listByProfile === "function") {
    return saveStore.listByProfile(profileId);
  }
  return [];
}

async function deleteByGameAndProfile(saveStore, gameId, profileId) {
  if (typeof saveStore.deleteByGameAndProfile === "function") {
    await saveStore.deleteByGameAndProfile(gameId, profileId);
  }
}
