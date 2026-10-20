// Keep memory/file behavior aligned with PostgreSQL INT wallet columns.
export function validateTransactionEffect(record, effect) {
  if (!String(record?.profileId || "").trim()) throw new Error("profileId is required");
  if (effect.coins && effect.subscription) throw new Error("only one transaction benefit is allowed");
  if (effect.coins) {
    const { gameId, delta } = effect.coins;
    if (!String(gameId || "").trim()) throw new Error("gameId is required");
    if (!Number.isInteger(delta) || delta < -2147483648 || delta > 2147483647) {
      throw new Error("coin delta must be a supported integer");
    }
  }
}
