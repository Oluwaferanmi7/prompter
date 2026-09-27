// Script storage for one signed-in person. Everything takes the user id from the verified
// session / OAuth token, never from the request body, so nobody can reach another library.

export const LIMITS = { title: 200, text: 500_000, batch: 500 };
const now = () => Date.now();
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export async function upsertUser(db, { id, email, name }) {
  await db
    .prepare('INSERT INTO users (id, email, name, rev, created) VALUES (?1, ?2, ?3, 0, ?4) ON CONFLICT(id) DO UPDATE SET email = ?2, name = ?3')
    .bind(id, email, name || null, now())
    .run();
}

export async function getUser(db, id) {
  return db.prepare('SELECT id, email, name, rev FROM users WHERE id = ?1').bind(id).first();
}

async function bump(db, userId) {
  const row = await db.prepare('UPDATE users SET rev = rev + 1 WHERE id = ?1 RETURNING rev').bind(userId).first();
  return row.rev;
}

function clean(s) {
  if (!s || typeof s.id !== 'string' || !s.id || s.id.length > 64) return null;
  if (typeof s.updated !== 'number' || !isFinite(s.updated)) return null;
  return {
    id: s.id,
    title: String(s.title ?? '').slice(0, LIMITS.title),
    text: String(s.text ?? '').slice(0, LIMITS.text),
    updated: Math.floor(s.updated),
    deleted: s.deleted ? 1 : 0,
  };
}

// Save one script if it's newer than what we have (newest edit wins, same rule as the
// phone-to-phone merge). Returns true if it was stored.
export async function put(db, userId, script) {
  const s = clean(script);
  if (!s) return false;
  const have = await db.prepare('SELECT updated FROM scripts WHERE user_id = ?1 AND id = ?2').bind(userId, s.id).first();
  if (have && have.updated >= s.updated) return false;
  const rev = await bump(db, userId);
  await db
    .prepare(
      `INSERT INTO scripts (user_id, id, title, text, updated, deleted, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(user_id, id) DO UPDATE SET title = ?3, text = ?4, updated = ?5, deleted = ?6, rev = ?7`
    )
    .bind(userId, s.id, s.title, s.text, s.updated, s.deleted, rev)
    .run();
  return true;
}

// Device sync: take the device's changed scripts, hand back everything changed since `since`.
export async function sync(db, userId, { since = 0, scripts = [] } = {}) {
  for (const s of (Array.isArray(scripts) ? scripts : []).slice(0, LIMITS.batch)) await put(db, userId, s);
  const user = await getUser(db, userId);
  const { results } = await db
    .prepare('SELECT id, title, text, updated, deleted FROM scripts WHERE user_id = ?1 AND rev > ?2 ORDER BY rev')
    .bind(userId, Math.max(0, Number(since) || 0))
    .all();
  return { rev: user?.rev || 0, scripts: results.map((r) => ({ ...r, deleted: !!r.deleted })) };
}

// ---- used by the Claude connector
export async function list(db, userId) {
  const { results } = await db
    .prepare('SELECT id, title, text, updated FROM scripts WHERE user_id = ?1 AND deleted = 0 ORDER BY updated DESC')
    .bind(userId)
    .all();
  return results;
}

export async function get(db, userId, id) {
  return db.prepare('SELECT id, title, text, updated FROM scripts WHERE user_id = ?1 AND id = ?2 AND deleted = 0').bind(userId, id).first();
}

export async function create(db, userId, { title, text }) {
  const s = { id: uid(), title: title || 'Untitled script', text: text || '', updated: now() };
  await put(db, userId, s);
  return s;
}

export async function update(db, userId, id, patch) {
  const cur = await get(db, userId, id);
  if (!cur) return null;
  // max() so an edit always wins even if a phone's clock runs a little ahead.
  const s = { id, title: patch.title ?? cur.title, text: patch.text ?? cur.text, updated: Math.max(now(), cur.updated + 1) };
  await put(db, userId, s);
  return s;
}
