import { timingSafeEqual } from 'node:crypto';

// Local Windows mode remains loopback-only and requires no password.
// Cloud mode is deliberately opt-in; missing credentials stop startup.
export function cloudModeEnabled(env = process.env) {
  return env.TOUCHLINE_CLOUD_MODE === '1';
}

export function validateCloudConfig(env = process.env) {
  if (!cloudModeEnabled(env)) return;
  if (typeof env.TOUCHLINE_ACCESS_PASSWORD !== 'string' || env.TOUCHLINE_ACCESS_PASSWORD.length < 20) {
    throw new Error('Cloud deployment requires TOUCHLINE_ACCESS_PASSWORD (at least 20 characters).');
  }
  if (typeof env.TOUCHLINE_DATA_DIR !== 'string' || !env.TOUCHLINE_DATA_DIR.startsWith('/')) {
    throw new Error('Cloud deployment requires TOUCHLINE_DATA_DIR on an absolute persistent disk path.');
  }
}

export function authorizedBasicHeader(header, password) {
  if (typeof header !== 'string' || typeof password !== 'string') return false;
  const expected = 'Basic ' + Buffer.from('touchline:' + password, 'utf8').toString('base64');
  const actualBytes = Buffer.from(header, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function requireCloudAccess(req, res, env = process.env) {
  if (!cloudModeEnabled(env)) return false;
  if (authorizedBasicHeader(req.headers.authorization, env.TOUCHLINE_ACCESS_PASSWORD)) return false;
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Touchline Studio", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end('Authentication required');
  return true;
}
