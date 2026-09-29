// Recordings made on this device ("Record yourself"). Video arrives from the recorder in
// one-second pieces; each piece is written to IndexedDB as it comes, so a long take never
// sits in memory and a crash or reload loses at most a second. The pieces joined in order
// are the complete file.
import { NS } from './store.js';
import { fixMp4 } from './mp4fix.js';

const DB = NS + 'sapphire-recordings';
let dbp = null;

function db() {
  if (!dbp)
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('recs', { keyPath: 'id' });
        d.createObjectStore('chunks'); // key: [id, n]
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  return dbp;
}

async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => (out = v));
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const req = (r) => new Promise((resolve, reject) => ((r.onsuccess = () => resolve(r.result)), (r.onerror = () => reject(r.error))));

export function begin(meta) {
  return tx(['recs'], 'readwrite', (t) => t.objectStore('recs').put({ ...meta, bytes: 0, chunks: 0, done: false }));
}

export function chunk(id, n, blob) {
  return tx(['recs', 'chunks'], 'readwrite', async (t) => {
    t.objectStore('chunks').put(blob, [id, n]);
    const recs = t.objectStore('recs');
    const r = await req(recs.get(id));
    if (r) recs.put({ ...r, bytes: r.bytes + blob.size, chunks: Math.max(r.chunks, n + 1), ended: Date.now() });
  });
}

export function end(id, patch = {}) {
  return tx(['recs'], 'readwrite', async (t) => {
    const recs = t.objectStore('recs');
    const r = await req(recs.get(id));
    if (r) recs.put({ ...r, ...patch, done: true });
  });
}

// Newest first. A recording that never finished (crash, reload, phone died) shows as
// recovered: everything up to the last saved second is there.
export async function list() {
  const all = await tx(['recs'], 'readonly', (t) => req(t.objectStore('recs').getAll()));
  return all.map((r) => ({ ...r, recovered: !r.done })).sort((a, b) => b.started - a.started);
}

// The file to save or share. MP4s get an index at the front (mp4fix.js) so they scrub in
// every player, not just on the iPhone; if that fails the recorder's file goes out as is.
const fixed = new Map(); // id → { bytes, file } so reopening the list doesn't redo it
export async function file(id) {
  const r = await tx(['recs'], 'readonly', (t) => req(t.objectStore('recs').get(id)));
  if (r && fixed.get(id)?.bytes === r.bytes) return fixed.get(id).file;
  if (!r) return null;
  const parts = await tx(['chunks'], 'readonly', (t) => req(t.objectStore('chunks').getAll(IDBKeyRange.bound([id, 0], [id, Infinity]))));
  const ext = /mp4/.test(r.mime) ? 'mp4' : 'webm';
  const d = new Date(r.started);
  const p2 = (n) => String(n).padStart(2, '0');
  const slug = (r.title || 'take').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const name = `${slug}-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.${ext}`;
  const type = r.mime.split(';')[0];
  const raw = new File(parts, name, { type });
  if (ext !== 'mp4') return raw;
  let out = raw;
  try {
    const f = await fixMp4(raw);
    if (f) out = new File([f], name, { type });
  } catch (err) {
    console.warn('mp4 fix failed, sharing the original', err);
  }
  fixed.set(id, { bytes: r.bytes, file: out });
  return out;
}

export function remove(id) {
  fixed.delete(id);
  return tx(['recs', 'chunks'], 'readwrite', (t) => {
    t.objectStore('recs').delete(id);
    t.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
  });
}
