// Passwords (scrypt) and signed session cookies (HMAC-SHA256). No dependencies.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const b64 = (buf) => Buffer.from(buf).toString('base64url');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${b64(salt)}$${b64(key)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Constant-time string comparison (for the admin password from the environment). */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url').replace(/[-_]/g, 'x');
export const userIdFor = (email) => crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);

const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

export function createToken(data, secret, days = 30) {
  const payload = b64(JSON.stringify({ ...data, exp: Date.now() + days * 864e5 }));
  return `${payload}.${sign(payload, secret)}`;
}

export function readToken(token, secret) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}
