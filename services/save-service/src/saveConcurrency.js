import { mergeSaveEnvelopes, validateSaveEnvelope } from "./saveEnvelope.js";
import { SaveValidationError } from "./saveErrors.js";
export function validateCompareAndSwap(envelope, expectedRevision) {
  validateSaveEnvelope(envelope);
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
    throw new SaveValidationError("expected revision must be null or a positive safe integer");
  }
  if (expectedRevision !== null && envelope.revision <= expectedRevision) {
    throw new SaveValidationError("new save revision must advance");
  }
}
export function migrateSaveEnvelope(primary, secondary, gameId, primaryId, secondaryId, nowSeconds) {
  if (!secondary) return null;
  validateSaveEnvelope(secondary);
  if (secondary.game_id !== gameId || secondary.profile_id !== secondaryId) throw new SaveValidationError("secondary save identity mismatch");
  if (primary) {
    validateSaveEnvelope(primary);
    if (primary.game_id !== gameId || primary.profile_id !== primaryId) throw new SaveValidationError("primary save identity mismatch");
  }
  const incoming = { ...secondary, profile_id: primaryId };
  return primary ? mergeSaveEnvelopes(incoming, primary, { nowSeconds }) : validateSaveEnvelope({ ...incoming, updated_at: Math.max(nowSeconds, incoming.updated_at) });
}
