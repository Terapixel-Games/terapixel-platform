// Never fall back to DATABASE_URL. A non-loopback hostname is accepted only for
// the exact synthetic, internal-only Compose fixture and its explicit marker.
export const COMPOSE_TEST_DATABASE_URL = 'postgresql://terapixel_test:synthetic-local-only@postgres:5432/terapixel_test';
export function localPostgresUrl(raw, env = process.env) {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) {
    throw new Error('invalid integration database URL/overrides');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const compose = env.TPX_ISOLATED_COMPOSE_TEST === '1' && raw === COMPOSE_TEST_DATABASE_URL;
  if (!loopback && !compose) throw new Error('integration DB must be loopback or the exact isolated Compose fixture');
  return url;
}
