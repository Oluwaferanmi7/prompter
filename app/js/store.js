// Local persistence: scripts (library lives on the remote), display settings, pairing code.
const K = {
  scripts: 'tp.scripts',
  active: 'tp.activeId',
  settings: 'tp.settings',
  code: 'tp.code',
  remoteCode: 'tp.remoteCode',
  cache: 'tp.prompterCache',
  role: 'tp.lastRole',
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — app still works for this session */
  }
}

export const DEFAULT_SETTINGS = {
  fontSize: 56, // px on the prompter
  lineHeight: 1.4,
  margin: 6, // % side padding
  mirrorX: true, // Desview glass reflects left↔right
  mirrorY: false,
  cuePos: 0.3, // reading line, fraction of screen height from top
  showCue: true,
  align: 'left',
  theme: 'white', // white | yellow | light
  countdown: 3, // seconds, 0 = off
  speed: 6, // 1..30 → speed * 0.1 lines/second
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(K.settings, {}) };
}
export function saveSettings(s) {
  write(K.settings, s);
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const WELCOME = `Welcome to your teleprompter.

This is a sample script. Open the Scripts tab on your remote to create your own, or tap the pencil to edit this one live.

Press play to start scrolling. Drag the preview on the remote to move the teleprompter to the exact same spot.

Use the arrows to jump back or forward a paragraph when you need a retake.

The Display tab controls font size, line spacing, margins and mirroring for the Desview glass.

Break a leg.`;

export function getScripts() {
  let list = read(K.scripts, null);
  if (!Array.isArray(list) || !list.length) {
    list = [{ id: uid(), title: 'Welcome', text: WELCOME, updated: Date.now() }];
    write(K.scripts, list);
  }
  return list;
}
export function saveScripts(list) {
  write(K.scripts, list);
}
export function getActiveId() {
  return read(K.active, null);
}
export function setActiveId(id) {
  write(K.active, id);
}

// Prompter keeps the last script it was sent so it can work standalone after a reload.
export function getPrompterCache() {
  return read(K.cache, null);
}
export function savePrompterCache(c) {
  write(K.cache, c);
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode() {
  let c = '';
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  for (const n of buf) c += ALPHABET[n % ALPHABET.length];
  return c;
}
export function getPrompterCode() {
  let c = read(K.code, null);
  if (!c) {
    c = newCode();
    write(K.code, c);
  }
  return c;
}
export function setPrompterCode(c) {
  write(K.code, c);
}
export function getRemoteCode() {
  return read(K.remoteCode, '');
}
export function setRemoteCode(c) {
  write(K.remoteCode, c);
}
export function getLastRole() {
  return read(K.role, null);
}
export function setLastRole(r) {
  write(K.role, r);
}
