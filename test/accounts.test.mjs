#!/usr/bin/env node
/*
 * Account tests. No framework:  node test/accounts.test.mjs
 * Password hashing and cookie primitives (lib/auth.js), both storage adapters
 * (lib/store.js, SQLite and the JSON fallback), the client's sign-in merge rule
 * (public/account.mjs), and the HTTP flow end to end against a live server on
 * a throwaway database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chooseState, totalReps } from '../public/account.mjs';

const require = createRequire(import.meta.url);
const auth = require('../lib/auth.js');
const { openStore } = require('../lib/store.js');

let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnps-acct-'));

console.log('\n# passwords + tokens\n');
const h = await auth.hashPassword('correct horse');
check(h.startsWith('scrypt$') && !h.includes('correct horse'), 'hash is scrypt and does not contain the password');
check(await auth.verifyPassword('correct horse', h), 'right password verifies');
check(!(await auth.verifyPassword('correct hors', h)), 'wrong password fails');
check(!(await auth.verifyPassword('x', 'garbage')), 'malformed stored hash fails closed');
check(h !== await auth.hashPassword('correct horse'), 'salted: same password, different hash');
const t = auth.newToken();
check(t.length >= 40 && auth.tokenHash(t) !== t && auth.tokenHash(t) === auth.tokenHash(t), 'token hashes deterministically');

console.log('\n# input rules\n');
check(auth.cleanUsername(' Kyle ') === 'kyle', 'usernames are trimmed and lower-cased');
check(auth.cleanUsername('ab') === null && auth.cleanUsername('a b c') === null && auth.cleanUsername('<x>') === null,
  'short, spaced or punctuated usernames are refused');
check(!auth.passwordOk('short') && auth.passwordOk('longenough') && !auth.passwordOk('x'.repeat(201)),
  'password length bounds');
check(auth.parseCookies('a=1; cnps_sid=abc%3D; a=2').cnps_sid === 'abc=' && auth.parseCookies('a=1; a=2').a === '1',
  'cookie parsing decodes and keeps the first duplicate');
const ck = auth.sessionCookie('tok', { maxAge: 60e3, secure: true });
check(/HttpOnly/.test(ck) && /SameSite=Lax/.test(ck) && /Secure/.test(ck) && /Max-Age=60/.test(ck), 'session cookie flags');

for (const kind of ['sqlite', 'file']) {
  console.log(`\n# store: ${kind}\n`);
  const dir = path.join(tmp, kind);
  const open = () => openStore({ dbFile: path.join(dir, 'a.db'), dir, kind });
  let s = open();
  if (kind === 'sqlite' && s.kind !== 'sqlite') { console.log('skip  node:sqlite unavailable on this Node'); continue; }
  check(s.kind === kind, `opens the ${kind} adapter`);
  const u = s.createUser('ana', 'H');
  check(u && u.username === 'ana' && Number.isInteger(u.id), 'creates a user');
  check(s.createUser('ana', 'H2') === null, 'a taken username returns null');
  check(s.findUser('ana').pass === 'H' && s.findUser('nobody') === null, 'finds by username');
  s.createSession('h1', u.id, Date.now() + 60e3);
  s.createSession('old', u.id, Date.now() - 1);
  check(s.getSession('h1').username === 'ana', 'session resolves to its user');
  check(s.getSession('old') === null, 'an expired session does not resolve');
  check(s.loadState(u.id) === null, 'no progress yet');
  s.saveState(u.id, '{"cards":{"1":{"reps":2}}}');
  s.saveState(u.id, '{"cards":{"1":{"reps":3}}}');
  const v = s.createUser('ben', 'H');
  s.saveState(v.id, '{"cards":{}}');
  check(JSON.parse(s.loadState(u.id)).cards['1'].reps === 3, 'saving again overwrites');
  check(s.loadState(v.id) === '{"cards":{}}', 'progress is per user');
  s.close();
  s = open();
  check(s.getSession('h1') && JSON.parse(s.loadState(u.id)).cards['1'].reps === 3, 'sessions and progress survive a restart');
  s.deleteSession('h1');
  check(s.getSession('h1') === null, 'a deleted session is gone');
  s.close();
}

console.log('\n# sign-in merge rule\n');
const deck = n => ({ cards: { 1: { reps: n } } });
check(totalReps(null) === -1 && totalReps(deck(4)) === 4, 'totalReps');
check(chooseState({ cached: deck(2), server: deck(5), serverKnown: true, guest: null }).chosen.cards[1].reps === 5,
  'more reps wins between the account copies');
const cachedTie = deck(5);
check(chooseState({ cached: cachedTie, server: deck(5), serverKnown: true }).chosen === cachedTie, 'a tie goes to the device copy');
let r = chooseState({ cached: null, server: null, serverKnown: true, guest: deck(9) });
check(r.adopted && r.chosen.cards[1].reps === 9, 'an empty account takes the guest deck');
r = chooseState({ cached: null, server: deck(1), serverKnown: true, guest: deck(9) });
check(!r.adopted && r.chosen.cards[1].reps === 1, 'an account with progress keeps its own, even if the guest deck is bigger');
r = chooseState({ cached: null, server: null, serverKnown: false, guest: deck(9) });
check(!r.adopted, 'offline sign-in never adopts the guest deck (the account may not really be empty)');

console.log('\n# http\n');
process.env.DB_FILE = path.join(tmp, 'http.db');
process.env.OFFLINE = '1';
const { server } = require('../server.js');
await new Promise(res => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = '';
const call = async (method, p, body, extra = {}) => {
  const headers = Object.assign(body !== undefined ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {}, extra);
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
};
try {
  check((await call('GET', '/api/auth/me')).body.user === null, 'signed out by default');
  check((await call('GET', '/api/me/state')).status === 401, 'account state needs a session');
  check((await call('POST', '/api/auth/register', { username: 'Cara', password: 'short' })).status === 400, 'weak password refused');
  r = await call('POST', '/api/auth/register', { username: 'Cara', password: 'longenough1' });
  check(r.status === 201 && r.body.user.username === 'cara' && /cnps_sid=/.test(cookie), 'register signs in');
  check((await call('POST', '/api/auth/register', { username: 'cara', password: 'longenough1' })).status === 409, 'duplicate username is 409');
  check((await call('GET', '/api/auth/me')).body.user.username === 'cara', 'me reports the user');
  check((await call('PUT', '/api/me/state', deck(7))).status === 200, 'saves progress');
  check((await call('GET', '/api/me/state')).body.cards[1].reps === 7, 'reads it back');
  check((await call('PUT', '/api/me/state', deck(1), { Origin: 'https://evil.example' })).status === 403, 'cross-origin write refused');
  const res = await fetch(base + '/api/me/state', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' });
  await res.body?.cancel();
  check(res.status === 403, 'non-JSON write refused (no simple-form CSRF)');
  check((await call('POST', '/api/auth/logout', {})).status === 200, 'logout');
  check((await call('GET', '/api/me/state')).status === 401, 'the old session no longer works');
  cookie = '';
  check((await call('POST', '/api/auth/login', { username: 'cara', password: 'wrongpass' })).status === 401, 'wrong password is 401');
  check((await call('POST', '/api/auth/login', { username: 'nobody', password: 'wrongpass' })).body.error ===
    'wrong username or password', 'unknown user gets the same answer as a wrong password');
  r = await call('POST', '/api/auth/login', { username: 'CARA', password: 'longenough1' });
  check(r.status === 200 && (await call('GET', '/api/me/state')).body.cards[1].reps === 7, 'login restores the progress');
  cookie = '';
  for (let i = 0; i < 10; i++) await call('POST', '/api/auth/login', { username: 'dee', password: 'wrongpass' });
  check((await call('POST', '/api/auth/login', { username: 'dee', password: 'wrongpass' })).status === 429, 'repeated failures lock the name out');
  check((await call('POST', '/api/auth/login', { username: 'dee', password: 'wrongpass' }, { 'X-Forwarded-For': '203.0.113.9' })).status === 401,
    'another client is not locked out by the first one\'s failures');

  // Attempts are counted when they arrive, not after scrypt returns, so a burst
  // of parallel guesses cannot all pass the lockout check before any is counted.
  check((await call('POST', '/api/auth/register', { username: 'eve', password: 'eve-password' })).status === 201, 'register eve');
  cookie = '';
  const burst = [];
  for (let i = 0; i < 10; i++) burst.push(call('POST', '/api/auth/login', { username: 'eve', password: `guess-${i}x` }, { 'X-Forwarded-For': '198.51.100.7' }));
  await new Promise(res => setTimeout(res, 20));
  const late = await call('POST', '/api/auth/login', { username: 'eve', password: 'eve-password' }, { 'X-Forwarded-For': '198.51.100.7' });
  await Promise.all(burst);
  check(late.status === 429, 'the 11th attempt in a parallel burst is refused, even with the right password');
  cookie = '';
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(fails ? 1 : 0);
