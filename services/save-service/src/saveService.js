import {
  createDefaultSaveEnvelope,
  mergeSaveEnvelopes,
  validateSaveEnvelope
} from "./saveEnvelope.js";
import { SaveConflictError, SaveValidationError } from "./saveErrors.js";
import { InMemorySaveStore } from "./saveStore.js";
import { createNoopRuntimeConfigProvider } from "../../../packages/shared-utils/index.js";

export function createSaveService(options = {}) {
  const saveStore = options.saveStore || new InMemorySaveStore();
  if (typeof saveStore.compareAndSwap !== "function") throw new Error("saveStore.compareAndSwap is required");
  const maxWriteAttempts = options.maxWriteAttempts ?? 5;
  if (!Number.isInteger(maxWriteAttempts) || maxWriteAttempts < 1 || maxWriteAttempts > 20) throw new Error("maxWriteAttempts must be between 1 and 20");
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
      return readServerEnvelope(saveStore, gameId, profileId);
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

      const hasClient = clientEnvelope !== null && clientEnvelope !== undefined;
      if (hasClient) {
        validateSaveEnvelope(clientEnvelope);
        assertEnvelopeIdentity(clientEnvelope, gameId, profileId);
      }
      for (let attempt = 0; attempt < maxWriteAttempts; attempt++) {
        const server = await readServerEnvelope(saveStore, gameId, profileId);
        if (!hasClient && server) return { envelope: server, source: "server" };
        const source = server ? "merged" : hasClient ? "client_first_write" : "created_default";
        const candidate = server
          ? mergeSaveEnvelopes(clientEnvelope, server, { nowSeconds: now })
          : hasClient
            ? { ...clientEnvelope, updated_at: Math.max(clientEnvelope.updated_at, now) }
            : createDefaultSaveEnvelope({ gameId, profileId, updatedAt: now });
        const result = await saveStore.compareAndSwap(candidate, server?.revision ?? null, server);
        if (result.applied) return { envelope: result.envelope, source };
        // Read again and remerge the ORIGINAL client envelope, never overwrite
        // the winner using a candidate calculated from a stale snapshot.
      }
      throw new SaveConflictError(await readServerEnvelope(saveStore, gameId, profileId));
    },
    mergeProfiles: async ({ primaryProfileId, secondaryProfileId, nowSeconds }) => {
      assertRequiredString(primaryProfileId, "primaryProfileId");
      assertRequiredString(secondaryProfileId, "secondaryProfileId");
      if (primaryProfileId === secondaryProfileId) {
        return { merged: false, affected_games: [] };
      }
      const now = normalizeNow(nowSeconds);
      if (typeof saveStore.listByProfile !== "function" || typeof saveStore.migrateProfileGame !== "function") {
        throw new Error("save store must support atomic per-game profile migration");
      }
      const secondaryRows = await saveStore.listByProfile(secondaryProfileId);
      const affectedGames = [];
      for (const gameId of new Set(secondaryRows.map((row) => row.game_id))) {
        let finished = false;
        for (let attempt = 0; attempt < maxWriteAttempts; attempt++) {
          try {
            const result = await saveStore.migrateProfileGame(gameId, primaryProfileId, secondaryProfileId, now);
            if (result.migrated) affectedGames.push(gameId);
            finished = true;
            break;
          } catch (error) {
            if (!(error instanceof SaveConflictError)) throw error;
          }
        }
        if (!finished) throw new SaveConflictError(await readServerEnvelope(saveStore, gameId, primaryProfileId));
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
    throw new SaveValidationError("game_id is not onboarded or is inactive");
  }
}

function assertRequiredString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new SaveValidationError(`${fieldName} is required`);
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
    throw new SaveValidationError("client envelope game_id mismatch");
  }
  if (envelope.profile_id !== profileId) {
    throw new SaveValidationError("client envelope profile_id mismatch");
  }
}

async function readServerEnvelope(store, gameId, profileId) {
  const envelope = await store.get(gameId, profileId);
  if (envelope) {
    validateSaveEnvelope(envelope);
    assertEnvelopeIdentity(envelope, gameId, profileId);
  }
  return envelope;
}
