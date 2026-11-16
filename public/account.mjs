/*
 * Accounts on the client: the /api/auth calls, plus the pure rule for which
 * copy of progress wins when a device signs in. No DOM, so
 * test/accounts.test.js imports it directly.
 */

export const totalReps = s => s ? Object.values(s.cards || {}).reduce((n, k) => n + (k.reps || 0), 0) : -1;

// cached = this device's copy of the account, server = the account's stored
// copy, guest = the anonymous-profile progress on screen at sign-in.
// Between the two account copies, more reps wins and a tie goes to the cache,
// the same rule the anonymous profiles use. Guest progress moves into the
// account only when the server has confirmed the account is empty. If the
// account fetch failed (offline), "empty" may only mean "unreachable", and
// adopting the guest deck would overwrite real progress on the next sync.
export function chooseState({ cached, server, serverKnown, guest }) {
  const mine = totalReps(server) > totalReps(cached) ? server : cached;
  if (serverKnown && totalReps(mine) <= 0 && totalReps(guest) > 0) return { chosen: guest, adopted: true };
  return { chosen: mine, adopted: false };
}

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

// null when signed out, and also when the server is unreachable, so the
// app still boots offline on the anonymous profile.
export async function whoami() {
  try {
    const r = await fetch('/api/auth/me', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// action: 'login' | 'register'. Resolves {user} or {error}, never throws.
export async function authenticate(action, username, password) {
  try {
    const r = await post(`/api/auth/${action}`, { username, password });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { user: j.user } : { error: j.error || `failed (${r.status})` };
  } catch { return { error: 'server unreachable' }; }
}

export async function signOut() {
  try { await post('/api/auth/logout'); } catch { /* the cookie lapses on its own */ }
}
