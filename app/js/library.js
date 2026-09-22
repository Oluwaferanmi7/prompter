// Script library. Every phone keeps its own copy; paired phones swap libraries and
// merge (newest edit wins per script). Deletes are kept as tombstones so they sync too.
import { uid, NS } from './store.js';

const KEY = NS + 'tp.scripts';
const ACTIVE = NS + 'tp.activeId';
const TOMBSTONE_TTL = 1000 * 60 * 60 * 24 * 60; // forget deletes after 60 days

export const WELCOME_ID = 'welcome';
// Fixed stamp so every phone's untouched sample merges as the same script.
const WELCOME_STAMP = Date.UTC(2026, 8, 21);
export const WELCOME = `Welcome to LiM Prompter.

This is a sample script. Open Scripts to create your own, or tap the pencil to edit this one.

Press play to start. On a second phone, tap Connect and enter this phone's code to control it remotely.

Drag the preview to move the teleprompter to the exact same spot. Use the arrows to jump back or forward a paragraph when you need a retake.

Mirror and Flip are right on the control screen. Font size and line spacing live under Aa.

Break a leg.`;

let list = load();
const listeners = new Set();

function load() {
  let l;
  try {
    l = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {}
  if (!Array.isArray(l)) l = [];
  // Migrate v1: the default script used a random id on each phone, which would
  // duplicate on merge. Give an untouched sample the shared id.
  for (const s of l) {
    if (s.id !== WELCOME_ID && s.title === 'Welcome' && /^Welcome to your teleprompter\./.test(s.text || '')) {
      s.id = WELCOME_ID;
      s.title = 'Welcome';
      s.text = WELCOME;
    }
  }
  // Migrate v1 prompter phone: it only held the last script it was sent.
  try {
    const cache = JSON.parse(localStorage.getItem(NS + 'tp.prompterCache') || 'null');
    const cs = cache?.script;
    if (cs?.id && typeof cs.text === 'string' && !l.some((s) => s.id === cs.id)) {
      l.push({ id: cs.id, title: cs.title || 'Untitled', text: cs.text, updated: Date.now() - 1000 });
    }
  } catch {}
  const now = Date.now();
  l = l.filter((s) => !(s.deleted && now - s.updated > TOMBSTONE_TTL));
  const seen = new Set();
  l = l.filter((s) => s?.id && !seen.has(s.id) && seen.add(s.id));
  if (!l.some((s) => !s.deleted)) l.push({ id: WELCOME_ID, title: 'Welcome', text: WELCOME, updated: WELCOME_STAMP });
  save(l);
  return l;
}

function save(l = list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {}
}

function emit(change) {
  for (const fn of listeners) fn(change);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const all = () => list.filter((s) => !s.deleted).sort((a, b) => b.updated - a.updated);
export const get = (id) => list.find((s) => s.id === id && !s.deleted) || null;
export const raw = () => list.slice();

export function getActiveId() {
  let id = null;
  try {
    id = JSON.parse(localStorage.getItem(ACTIVE) || 'null');
  } catch {}
  return get(id) ? id : all()[0].id;
}
export function setActiveId(id) {
  try {
    localStorage.setItem(ACTIVE, JSON.stringify(id));
  } catch {}
}
export const active = () => get(getActiveId());

// Local edit. Returns the updated script. `source` lets the sync layer avoid echoes.
export function upsert(patch, source = 'local') {
  const i = list.findIndex((s) => s.id === patch.id);
  const s = { ...(i >= 0 ? list[i] : { title: 'Untitled script', text: '' }), ...patch, updated: patch.updated ?? Date.now() };
  if (i >= 0) list[i] = s;
  else list.push(s);
  save();
  emit({ type: 'upsert', script: s, source });
  return s;
}

export function create(title = 'Untitled script', text = '') {
  return upsert({ id: uid(), title, text });
}

export function remove(id) {
  const s = list.find((x) => x.id === id);
  if (!s) return;
  upsert({ id, title: s.title, text: '', deleted: true });
  if (!list.some((x) => !x.deleted)) upsert({ id: uid(), title: 'Untitled script', text: '' });
}

// Merge scripts from another phone. Returns the ids that changed here.
export function merge(incoming, source = 'remote') {
  const changed = [];
  for (const s of incoming || []) {
    if (!s?.id || typeof s.updated !== 'number') continue;
    const mine = list.find((x) => x.id === s.id);
    if (mine && mine.updated >= s.updated) continue;
    const clean = { id: s.id, title: String(s.title ?? ''), text: String(s.text ?? ''), updated: s.updated, ...(s.deleted ? { deleted: true } : {}) };
    if (mine) Object.assign(mine, clean);
    else list.push(clean);
    changed.push(s.id);
  }
  // The shared sample never beats a real script as "the only one" — fine as is.
  if (changed.length) {
    save();
    emit({ type: 'merge', ids: changed, source });
  }
  return changed;
}

export function importBackup(scripts) {
  let added = 0;
  for (const s of scripts || []) {
    if (typeof s?.text !== 'string') continue;
    if (!list.some((x) => x.id === s.id)) added++;
  }
  merge(
    (scripts || []).filter((s) => typeof s?.text === 'string').map((s) => ({ id: s.id || uid(), title: s.title || 'Imported', text: s.text, updated: s.updated || Date.now() })),
    'local'
  );
  return added;
}
