export const SAVE_ENVELOPE_SCHEMA_VERSION = 1;

const DEFAULT_PAYLOAD = Object.freeze({
  high_score: 0,
  last_play_date: "",
  streak_days: 0,
  streak_at_risk: 0,
  games_played: 0,
  selected_track_id: "glassgrid"
});

export function createDefaultSaveEnvelope(input = {}) {
  const now = normalizeUnix(input.updatedAt || Math.floor(Date.now() / 1000));
  const payload = {
    ...DEFAULT_PAYLOAD,
    ...(input.payload || {})
  };
  const envelope = {
    schema_version: SAVE_ENVELOPE_SCHEMA_VERSION,
    game_id: String(input.gameId || ""),
    profile_id: String(input.profileId || ""),
    revision: normalizeInt(input.revision, 1),
    updated_at: now,
    payload
  };
  validateSaveEnvelope(envelope);
  return envelope;
}

export function validateSaveEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("save envelope must be an object");
  }
  if (normalizeInt(envelope.schema_version, -1) < 1) {
    throw new Error("save envelope schema_version must be >= 1");
  }
  if (!envelope.game_id || typeof envelope.game_id !== "string") {
    throw new Error("save envelope game_id is required");
  }
  if (!envelope.profile_id || typeof envelope.profile_id !== "string") {
    throw new Error("save envelope profile_id is required");
  }
  if (normalizeInt(envelope.revision, -1) < 1) {
    throw new Error("save envelope revision must be >= 1");
  }
  if (normalizeUnix(envelope.updated_at) <= 0) {
    throw new Error("save envelope updated_at must be > 0");
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    throw new Error("save envelope payload must be an object");
  }
  return envelope;
}

export function mergeSaveEnvelopes(localEnvelope, remoteEnvelope, options = {}) {
  validateSaveEnvelope(localEnvelope);
  validateSaveEnvelope(remoteEnvelope);

  if (localEnvelope.game_id !== remoteEnvelope.game_id) {
    throw new Error("cannot merge envelopes with different game_id");
  }
  if (localEnvelope.profile_id !== remoteEnvelope.profile_id) {
    throw new Error("cannot merge envelopes with different profile_id");
  }

  const fresher = pickFresherEnvelope(localEnvelope, remoteEnvelope);
  const older = fresher === localEnvelope ? remoteEnvelope : localEnvelope;

  const mergedPayload = mergePayload(fresher.payload, older.payload);
  const now = normalizeUnix(options.nowSeconds || Math.floor(Date.now() / 1000));

  return {
    schema_version: Math.max(
      normalizeInt(localEnvelope.schema_version, 1),
      normalizeInt(remoteEnvelope.schema_version, 1)
    ),
    game_id: fresher.game_id,
    profile_id: fresher.profile_id,
    revision:
      Math.max(
        normalizeInt(localEnvelope.revision, 1),
        normalizeInt(remoteEnvelope.revision, 1)
      ) + 1,
    updated_at: Math.max(now, fresher.updated_at, older.updated_at),
    payload: mergedPayload
  };
}

function pickFresherEnvelope(a, b) {
  if (a.revision > b.revision) {
    return a;
  }
  if (b.revision > a.revision) {
    return b;
  }
  if (a.updated_at >= b.updated_at) {
    return a;
  }
  return b;
}

function mergePayload(primaryPayload, secondaryPayload) {
  const primary = { ...DEFAULT_PAYLOAD, ...primaryPayload };
  const secondary = { ...DEFAULT_PAYLOAD, ...secondaryPayload };
  const merged = { ...primary };

  merged.high_score = Math.max(
    normalizeInt(primary.high_score, 0),
    normalizeInt(secondary.high_score, 0)
  );
  merged.streak_days = Math.max(
    normalizeInt(primary.streak_days, 0),
    normalizeInt(secondary.streak_days, 0)
  );
  merged.streak_at_risk = Math.max(
    normalizeInt(primary.streak_at_risk, 0),
    normalizeInt(secondary.streak_at_risk, 0)
  );
  merged.games_played = Math.max(
    normalizeInt(primary.games_played, 0),
    normalizeInt(secondary.games_played, 0)
  );
  merged.last_play_date = maxDateString(
    String(primary.last_play_date || ""),
    String(secondary.last_play_date || "")
  );

  if (!primary.selected_track_id && secondary.selected_track_id) {
    merged.selected_track_id = String(secondary.selected_track_id);
  }

  // Preserve unknown keys from both payloads. Primary wins on conflict.
  for (const [key, value] of Object.entries(secondary)) {
    if (!(key in merged)) {
      merged[key] = value;
    }
  }

  return merged;
}

function maxDateString(a, b) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a >= b ? a : b;
}

function normalizeInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeUnix(value) {
  const parsed = normalizeInt(value, 0);
  return parsed > 0 ? parsed : 0;
}
