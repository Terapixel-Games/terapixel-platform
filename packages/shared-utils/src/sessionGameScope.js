// Apply only to verified claims. Absence preserves existing platform-wide web sessions.
export function sessionAllowsGame(claims, requestedGameId) {
  if (!claims || !Object.prototype.hasOwnProperty.call(claims, "game_id")) return true;
  const game = claims.game_id;
  if (typeof game !== "string" || !game || game !== game.trim().toLowerCase()) return false;
  return requestedGameId === game;
}
