// Local persistence for this phone: display settings, app preferences, pairing codes.
// Test bench only: ?bench=a|b keeps two same-origin frames from sharing one storage.
export const NS = (() => {
  const b = new URLSearchParams(location.search).get('bench');
  return b ? `bench.${b}.` : '';
})();
const K = {
  settings: 'tp.settings',
  prefs: 'tp.prefs',
  code: 'tp.code',
  remoteCode: 'tp.remoteCode',
  pos: 'tp.pos',
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — app still works for this session */
  }
}

// Display settings apply to THIS phone's teleprompter. A remote edits the target's copy.
export const DEFAULT_SETTINGS = {
  fontSize: 56,
  lineHeight: 1.4,
  margin: 6, // % side padding
  mirrorX: true, // Desview glass reflects left↔right
  mirrorY: false,
  cuePos: 0.3, // reading line, fraction of screen height from top
  showCue: true,
  align: 'left',
  theme: 'white', // white | yellow | light
  countdown: 3, // seconds before scrolling starts, 0 = off
  speed: 6, // 1..30 → speed * 0.1 lines/second
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(K.settings, {}) };
}
export function saveSettings(s) {
  write(K.settings, s);
}

// App preferences (how this phone's UI looks/behaves).
export const DEFAULT_PREFS = {
  mode: 'auto', // auto | dark | light
  showBar: true, // control bar on the teleprompter screen
  seenTip: false,
};
export function getPrefs() {
  return { ...DEFAULT_PREFS, ...read(K.prefs, {}) };
}
export function savePrefs(p) {
  write(K.prefs, p);
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode() {
  let c = '';
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  for (const n of buf) c += ALPHABET[n % ALPHABET.length];
  return c;
}
export function getMyCode() {
  let c = read(K.code, null);
  if (!c) {
    c = newCode();
    write(K.code, c);
  }
  return c;
}
export function setMyCode(c) {
  write(K.code, c);
}
export function getRemoteCode() {
  return read(K.remoteCode, '');
}
export function setRemoteCode(c) {
  write(K.remoteCode, c);
}

// Last reading position so a reload lands where you were.
export function getPos() {
  return read(K.pos, null);
}
export function savePos(p) {
  write(K.pos, p);
}
