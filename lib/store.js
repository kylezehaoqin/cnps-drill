'use strict';
/*
 * Account storage adapter: users, sessions, per-user progress.
 *
 * SQLite through node:sqlite (built into Node 22.5+) keeps the zero-dependency
 * rule and works with OFFLINE=1. It's a single file on the data volume, so the
 * nightly data backup covers it. On an older Node, where node:sqlite does not
 * exist, the same interface is backed by JSON files, so accounts still work on
 * the Node 18 floor. Both are synchronous: every call is a single-row read or
 * write, and a sync API leaves no window for two requests to interleave.
 *
 *   createUser(username, passHash) -> {id, username} | null (taken)
 *   findUser(username)             -> {id, username, pass} | null
 *   createSession(hash, userId, expires)
 *   getSession(hash)               -> {userId, username, expires} | null
 *   touchSession(hash, expires)
 *   deleteSession(hash)
 *   loadState(userId)              -> JSON string | null
 *   saveState(userId, json)
 *   close()
 */

const fs = require('fs');
const path = require('path');

function loadSqlite() {
  // node:sqlite announces itself with an ExperimentalWarning on every boot.
  // check.sh treats any warning as a failure (it is how the fetch leak was
  // caught), so mute that one warning and nothing else.
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    if (/SQLite/i.test(String(w && w.message || w))) return;
    return emit.call(process, w, ...rest);
  };
  try { return require('node:sqlite'); }
  catch { return null; }
  finally { process.emitWarning = emit; }
}

// Bump with an ALTER/CREATE step below; never rewrite an earlier step, so an
// existing database migrates forward on open without losing anything.
const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     pass TEXT NOT NULL,
     created INTEGER NOT NULL);
   CREATE TABLE sessions (
     hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires INTEGER NOT NULL);
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE progress (
     user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     state TEXT NOT NULL,
     updated INTEGER NOT NULL);`,
];

function sqliteStore(sqlite, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  let v = db.prepare('PRAGMA user_version').get().user_version;
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());

  const q = {
    insUser: db.prepare('INSERT INTO users (username, pass, created) VALUES (?, ?, ?)'),
    user: db.prepare('SELECT id, username, pass FROM users WHERE username = ?'),
    insSess: db.prepare('INSERT INTO sessions (hash, user_id, expires) VALUES (?, ?, ?)'),
    sess: db.prepare(`SELECT s.user_id AS userId, u.username, s.expires
                        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?`),
    touch: db.prepare('UPDATE sessions SET expires = ? WHERE hash = ?'),
    delSess: db.prepare('DELETE FROM sessions WHERE hash = ?'),
    prune: db.prepare('DELETE FROM sessions WHERE expires < ?'),
    state: db.prepare('SELECT state FROM progress WHERE user_id = ?'),
    putState: db.prepare(`INSERT INTO progress (user_id, state, updated) VALUES (?, ?, ?)
                          ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated = excluded.updated`),
  };

  return {
    kind: 'sqlite',
    createUser(username, pass) {
      try {
        const r = q.insUser.run(username, pass, Date.now());
        return { id: Number(r.lastInsertRowid), username };
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) return null;
        throw e;
      }
    },
    findUser: u => q.user.get(u) || null,
    createSession(hash, userId, expires) { q.prune.run(Date.now()); q.insSess.run(hash, userId, expires); },
    getSession(hash) {
      const s = q.sess.get(hash);
      if (!s) return null;
      if (s.expires < Date.now()) { q.delSess.run(hash); return null; }
      return s;
    },
    touchSession(hash, expires) { q.touch.run(expires, hash); },
    deleteSession(hash) { q.delSess.run(hash); },
    loadState(userId) { const r = q.state.get(userId); return r ? r.state : null; },
    saveState(userId, json) { q.putState.run(userId, json, Date.now()); },
    close() { db.close(); },
  };
}

// Fallback for Node < 22.5. accounts.json holds users + sessions; each user's
// progress is its own file, mirroring data/states/ but in a separate directory
// so a legacy profile name can never collide with an account.
function fileStore(dir) {
  const progress = path.join(dir, 'progress');
  fs.mkdirSync(progress, { recursive: true });
  const file = path.join(dir, 'accounts.json');
  let data = { nextId: 1, users: {}, sessions: {} };
  try { data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* first run */ }

  const write = (f, body) => {
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, f);
  };
  const persist = () => write(file, JSON.stringify(data));
  const prune = () => {
    const now = Date.now();
    for (const [h, s] of Object.entries(data.sessions)) if (s.expires < now) delete data.sessions[h];
  };
  const byId = id => Object.values(data.users).find(u => u.id === id);

  return {
    kind: 'file',
    createUser(username, pass) {
      if (data.users[username]) return null;
      const u = { id: data.nextId++, username, pass, created: Date.now() };
      data.users[username] = u;
      persist();
      return { id: u.id, username };
    },
    findUser(u) { const r = data.users[u]; return r ? { id: r.id, username: r.username, pass: r.pass } : null; },
    createSession(hash, userId, expires) { prune(); data.sessions[hash] = { userId, expires }; persist(); },
    getSession(hash) {
      const s = data.sessions[hash];
      if (!s) return null;
      const u = byId(s.userId);
      if (!u || s.expires < Date.now()) { delete data.sessions[hash]; persist(); return null; }
      return { userId: s.userId, username: u.username, expires: s.expires };
    },
    touchSession(hash, expires) { if (data.sessions[hash]) { data.sessions[hash].expires = expires; persist(); } },
    deleteSession(hash) { if (data.sessions[hash]) { delete data.sessions[hash]; persist(); } },
    loadState(userId) {
      try { return fs.readFileSync(path.join(progress, `${userId}.json`), 'utf8'); } catch { return null; }
    },
    saveState(userId, json) { write(path.join(progress, `${userId}.json`), json); },
    close() {},
  };
}

// STORE=file forces the JSON fallback (tests use it to cover both adapters).
function openStore({ dbFile, dir, kind = process.env.STORE }) {
  const sqlite = kind === 'file' ? null : loadSqlite();
  return sqlite ? sqliteStore(sqlite, dbFile) : fileStore(dir);
}

module.exports = { openStore };
