// Cloud library: optional Sign in with Google. Signed in, this device's scripts sync to
// the person's own library on the server (newest edit wins, deletes carry over, same as
// the phone-to-phone merge), on open and every few seconds while the app is in front.
// That library is also what their Claude edits through the connector. Signed out, the
// app is exactly as before: scripts live on the device and travel between paired devices.
import * as lib from './library.js';
import { NS } from './store.js';
import { CLOUD_URL } from './config.js';

const KEY = NS + 'tp.cloud';
const POLL = 5000;
const skip = (s) => s.id === lib.WELCOME_ID; // the built-in sample stays local

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null') || {};
  } catch {
    return {};
  }
}

export function createCloud({ toast, onChange }) {
  const enabled = !!CLOUD_URL;
  let st = load(); // { token, email, name, rev, dirty: [] }
  const dirty = new Set(st.dirty || []);
  let busy = false;
  let again = false;
  let timer = 0;
  let status = st.token ? 'idle' : 'out'; // out | idle | syncing | offline | error
  const save = () => {
    st.dirty = [...dirty];
    try {
      localStorage.setItem(KEY, JSON.stringify(st));
    } catch {}
  };
  const set = (s) => {
    if (status !== s) {
      status = s;
      onChange?.();
    }
  };

  async function api(path, body) {
    const res = await fetch(CLOUD_URL + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(st.token ? { authorization: 'Bearer ' + st.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Cloud error'), { status: res.status });
    return data;
  }

  // Anything changed on this device (or arriving from a paired device) goes up next sync.
  lib.subscribe((change) => {
    if (!st.token || change.source === 'cloud') return;
    const ids = change.type === 'merge' ? change.ids : [change.script.id];
    for (const id of ids) dirty.add(id);
    save();
    soon(800);
  });

  async function sync() {
    if (!enabled || !st.token) return;
    if (busy) return void (again = true);
    busy = true;
    set('syncing');
    try {
      const sending = [...dirty];
      const scripts = lib.raw().filter((s) => sending.includes(s.id) && !skip(s));
      const res = await api('/api/sync', { since: st.rev || 0, scripts });
      for (const id of sending) dirty.delete(id);
      st.rev = res.rev;
      save();
      if (res.scripts?.length) lib.merge(res.scripts, 'cloud');
      set('idle');
    } catch (err) {
      if (err.status === 401) {
        signedOut('Signed out of the cloud library. Sign in again from Home.');
      } else set(navigator.onLine === false ? 'offline' : 'error');
    } finally {
      busy = false;
      if (again) {
        again = false;
        soon(300);
      }
    }
  }
  function soon(ms) {
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  }
  function tick() {
    clearTimeout(timer);
    if (!st.token) return;
    if (document.visibilityState === 'visible') sync();
    timer = setTimeout(tick, POLL);
  }
  function signedOut(msg) {
    st = {};
    dirty.clear();
    save();
    set('out');
    if (msg) toast?.(msg);
  }

  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && st.token && soon(200));
  window.addEventListener('online', () => st.token && soon(200));
  if (st.token) soon(500);

  return {
    enabled,
    get signedIn() {
      return !!st.token;
    },
    get email() {
      return st.email || '';
    },
    get status() {
      return status;
    },
    // Off to Google (via the server), back to this page with a one-time code.
    signIn() {
      const back = location.href.split('#')[0];
      location.href = `${CLOUD_URL}/google/start?return=${encodeURIComponent(back)}`;
    },
    // Back from Google: trade the one-time code for this device's token.
    async finishSignIn(code) {
      try {
        const res = await api('/api/session', { code });
        st = { token: res.token, email: res.email, name: res.name, rev: 0 };
        for (const s of lib.raw()) if (!skip(s)) dirty.add(s.id); // first sync: send everything
        save();
        set('idle');
        toast?.(`Signed in as ${res.email}. Scripts sync to your library.`);
        soon(100);
      } catch (err) {
        toast?.(err.message || 'Sign-in failed');
      }
    },
    async signOut() {
      try {
        await api('/api/logout', {});
      } catch {}
      signedOut('Signed out. Scripts stay on this device.');
    },
    syncNow: () => soon(0),
  };
}
