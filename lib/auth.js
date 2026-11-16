'use strict';
/*
 * Account primitives: password hashing, session tokens, cookies, input rules.
 * Pure (no IO beyond crypto), so test/accounts.test.js covers them directly.
 */

const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

// N=2^14 is Node's default and ~50 ms per hash on a small VPS: slow enough to
// make an offline guess expensive, fast enough not to stall the event loop
// (crypto.scrypt runs on the libuv pool, not the main thread).
const N = 16384, R = 8, P = 1, KEYLEN = 32;

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// The cost parameters travel with the hash, so raising N later still verifies
// every password stored under the old one.
async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64');
  let got;
  try { got = await scrypt(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +n, r: +r, p: +p }); }
  catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Verified against when the username does not exist, so a miss costs the same
// time as a wrong password and response timing does not enumerate accounts.
let dummy;
async function burnVerify(pw) {
  dummy = dummy || await hashPassword(crypto.randomBytes(8).toString('hex'));
  await verifyPassword(pw, dummy);
  return false;
}

// The cookie carries the token; the store keeps only its hash, so a copied
// database (backups are nightly) cannot be replayed as live sessions.
const newToken = () => crypto.randomBytes(32).toString('base64url');
const tokenHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');

// Lower-cased so "Kyle" and "kyle" cannot be two accounts.
function cleanUsername(u) {
  const s = String(u == null ? '' : u).trim().toLowerCase();
  return /^[a-z0-9_-]{3,32}$/.test(s) ? s : null;
}
// Upper bound stops a multi-megabyte "password" from being fed to scrypt.
const passwordOk = pw => typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed, skip */ }
    }
  }
  return out;
}

const COOKIE = 'cnps_sid';
function sessionCookie(token, { maxAge, secure }) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}`
    + (secure ? '; Secure' : '');
}
const clearCookie = secure => sessionCookie('', { maxAge: 0, secure });

module.exports = {
  hashPassword, verifyPassword, burnVerify, newToken, tokenHash,
  cleanUsername, passwordOk, parseCookies, sessionCookie, clearCookie, COOKIE,
};
