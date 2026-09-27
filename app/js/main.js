import { Link } from './link.js';
import { createPrompter } from './prompter.js';
import { createRemote } from './remote.js';
import { applyMode } from './controls.js';
import * as lib from './library.js';
import * as store from './store.js';
import { createTakeLog } from './takelog.js';
import { createHome } from './home.js';

const $ = (id) => document.getElementById(id);

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}

// Test bench only: a hidden browser pane pauses animation frames; ?raf=timer ticks them.
if (store.NS && new URLSearchParams(location.search).has('raf')) {
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
}

applyMode();

const settings = store.getSettings();
let prompter;
let remote;
let home;
const log = createTakeLog({ code: store.getMyCode() });

// ------------------------------------------------------------------ link + protocol
const link = new Link({
  code: store.getMyCode(),
  onMessage: handle,
  onStatus: () => {
    prompter?.linkStatus();
    remote?.linkStatus();
    home?.refresh();
  },
  onControllerChange(attached, code) {
    if (attached) {
      // A phone just connected: give it our library, display settings and position.
      link.sendTo(code, { t: 'sync', scripts: lib.raw(), settings: prompter.engine.settings, activeId: prompter.engine.script?.id });
      prompter.engine.poke();
      roster.joined(code);
    } else roster.left(code);
    prompter?.linkStatus();
  },
  onOpen() {
    // We just connected to a teleprompter: swap libraries and say how we're joining.
    link.send({ t: 'sync', scripts: lib.raw() });
    link.send({ t: 'hello', role: hub.role });
    toast('Connected to teleprompter');
    remote?.linkStatus();
  },
});

// ------------------------------------------------------------------ phones on this teleprompter
// Every connected phone joins as a Remote or a Viewer (its own choice, saved on that
// phone). With "One remote" (the default) a single remote drives; another remote can take
// over deliberately. The seat stays with a remote whose phone just locked, so putting the
// phone down between takes never hands control to someone else.
const SEAT_HOLD = 30 * 60 * 1000;
const roster = (() => {
  const roles = new Map(); // code -> 'remote' | 'viewer'
  const seen = new Set(); // codes announced in the take log this connection
  let seat = store.getPrefs().seat || null;
  let seatLeft = Date.now(); // after a reload, treat the seat holder as just-left
  const online = (c) => !!c && link.controllerCodes.includes(c);
  const role = (c) => roles.get(c) || 'remote';
  const saveSeat = () => {
    const p = store.getPrefs();
    p.seat = seat;
    store.savePrefs(p);
  };
  function pickSeat() {
    const before = seat;
    if (seat && online(seat) && role(seat) === 'remote') return false;
    if (seat && !online(seat) && Date.now() - seatLeft < SEAT_HOLD) return false;
    seat = link.controllerCodes.find((c) => role(c) === 'remote') || null;
    if (seat !== before) saveSeat();
    return seat !== before;
  }
  const r = {
    get multi() {
      return !!store.getPrefs().multiRemote;
    },
    setMulti(v) {
      const p = store.getPrefs();
      p.multiRemote = !!v;
      store.savePrefs(p);
      pickSeat();
      r.broadcast();
    },
    role,
    canControl: (c) => role(c) === 'remote' && (r.multi || seat === c),
    joined() {
      pickSeat();
      r.broadcast();
    },
    hello(c, next) {
      const changed = roles.get(c) !== next;
      roles.set(c, next === 'viewer' ? 'viewer' : 'remote');
      if (changed || !seen.has(c)) log.event('phone', { code: c, on: true, role: role(c) });
      seen.add(c);
      if (role(c) === 'viewer' && seat === c) seat = null;
      pickSeat();
      r.broadcast();
      toast(role(c) === 'viewer' ? `${c} is watching` : r.canControl(c) ? `Remote ${c} connected` : `${c} connected (waiting)`);
    },
    takeover(c) {
      if (role(c) !== 'remote' || seat === c) return r.broadcast();
      seat = c;
      saveSeat();
      log.event('control', { code: c });
      toast(`${c} took control`);
      r.broadcast();
    },
    left(c) {
      if (seen.delete(c)) log.event('phone', { code: c, on: false, role: role(c) });
      if (c === seat) seatLeft = Date.now();
      r.broadcast();
    },
    tick() {
      if (pickSeat()) r.broadcast();
    },
    list: () => link.controllerCodes.map((c) => ({ code: c, role: role(c), control: r.canControl(c) })),
    summary() {
      const l = r.list();
      const rem = l.filter((p) => p.role === 'remote').length;
      const view = l.length - rem;
      const parts = [];
      if (rem) parts.push(rem === 1 ? 'Remote' : `${rem} remotes`);
      if (view) parts.push(`${view} viewer${view > 1 ? 's' : ''}`);
      return parts.join(' + ') || 'Remote';
    },
    broadcast() {
      const phones = r.list();
      for (const p of phones) link.sendTo(p.code, { t: 'roster', you: { role: p.role, control: p.control }, multi: r.multi, seat, seatOnline: online(seat), phones });
      prompter?.linkStatus();
      home?.refresh();
    },
  };
  setInterval(() => r.tick(), 5000);
  return r;
})();

// Shared by both screens' Connect tabs.
const hub = {
  roster: () => roster.list(),
  get multi() {
    return roster.multi;
  },
  setMulti: (v) => roster.setMulti(v),
  get role() {
    return store.getPrefs().role === 'viewer' ? 'viewer' : 'remote';
  },
  setRole(v) {
    const p = store.getPrefs();
    p.role = v === 'viewer' ? 'viewer' : 'remote';
    store.savePrefs(p);
    link.send({ t: 'hello', role: p.role });
    remote?.linkStatus();
  },
  get info() {
    return remote?.rosterInfo || null;
  },
  takeover: () => link.send({ t: 'takeover' }),
};

let wasTarget = 'idle';
setInterval(() => {
  if (link.targetStatus !== wasTarget) {
    if (wasTarget === 'connected' && link.targetStatus === 'connecting') toast('Lost the teleprompter — reconnecting…');
    wasTarget = link.targetStatus;
  }
}, 500);

// Messages anyone connected may send; everything else needs control.
const OPEN = new Set(['sync', 'hello', 'takeover', 'getlogs', 'getlog']);

function handle(msg, from, code) {
  if (from === 'controller') {
    // A phone connected to this teleprompter.
    if (!OPEN.has(msg?.t) && !roster.canControl(code)) return;
    log.actor = code;
    try {
      fromController(msg, code);
    } finally {
      log.actor = 'local';
    }
  } else fromTarget(msg);
}

function fromController(msg, code) {
  const e = prompter.engine;
  const c = prompter.ctl;
  switch (msg?.t) {
    case 'hello':
      roster.hello(code, msg.role);
      break;
    case 'takeover':
      roster.takeover(code);
      break;
    case 'getlogs':
      link.sendTo(code, { t: 'logs', list: log.sessions() });
      break;
    case 'getlog':
      link.sendTo(code, { t: 'log', id: msg.id, data: log.get(msg.id) });
      break;
    case 'sync':
      lib.merge(msg.scripts, 'remote:' + code);
      break;
    case 'play':
      e.play();
      break;
    case 'pause':
      e.pause();
      break;
    case 'toggle':
      e.toggle();
      break;
    case 'speed':
      c.setSpeed(msg.v);
      break;
    case 'seek':
      c.seekAnchor(msg.a, msg.drag);
      break;
    case 'para':
      c.para(msg.dir);
      break;
    case 'nudge':
      c.nudge(msg.lines);
      break;
    case 'page':
      c.page(msg.dir);
      break;
    case 'top':
      c.top();
      break;
    case 'voice':
      e.setVoice(msg.on);
      break;
    case 'select':
      c.select(msg.id, { fromRemote: true });
      break;
    case 'setting':
      c.setSetting(msg.key, msg.value);
      break;
    case 'upsert':
      lib.upsert(msg.script, 'remote:' + code);
      break;
  }
}

function fromTarget(msg) {
  // We are connected to another phone's teleprompter.
  switch (msg?.t) {
    case 'roster':
      remote.onRoster(msg);
      break;
    case 'logs':
    case 'log':
      remote.onReply(msg);
      break;
    case 'sync':
      lib.merge(msg.scripts, 'remote');
      remote.onSettings(msg.settings);
      if (msg.activeId) remote.onSelect(msg.activeId);
      break;
    case 'state':
      remote.onState(msg);
      break;
    case 'settings':
      remote.onSettings(msg.settings);
      break;
    case 'select':
      remote.onSelect(msg.id);
      break;
    case 'upsert':
      lib.upsert(msg.script, 'remote');
      break;
    case 'voice-status':
      remote.onVoiceStatus(msg.s, msg.detail);
      break;
  }
}

// Library changes: keep both screens current and mirror local edits to whoever is linked.
lib.subscribe((change) => {
  const ids = change.type === 'merge' ? change.ids : [change.script.id];
  for (const id of ids) {
    prompter.scriptChanged(id);
    remote.scriptChanged(id);
  }
  if (change.source === 'local' && change.type === 'upsert') {
    link.send({ t: 'upsert', script: change.script });
    link.sendToController({ t: 'upsert', script: change.script });
  } else if (change.source.startsWith('remote:')) {
    // An edit from one connected phone: pass it on to the others so every library and
    // preview stays in step.
    const from = change.source.slice(7);
    const scripts = change.type === 'merge' ? change.ids.map((id) => lib.raw().find((s) => s.id === id)).filter(Boolean) : [change.script];
    for (const script of scripts) link.sendToController({ t: 'upsert', script }, from);
  }
});

// ------------------------------------------------------------------ screens
// Screens: #/home, #/remote, and no hash = this device's teleprompter.
const showRemote = () => (location.hash = '#/remote');
const showLocal = () => (location.hash = '');
const showHome = () => (location.hash = '#/home');

prompter = createPrompter({
  link,
  log,
  roster,
  hub,
  settings,
  toast,
  onOpenRemote: showRemote,
  onHome: showHome,
  onState: (s) => link.sendToController({ t: 'state', ...s }),
  onSettings: (s) => link.sendToController({ t: 'settings', settings: s }),
  onSelect: (id) => link.sendToController({ t: 'select', id }),
  onVoiceStatus: (s, detail) => link.sendToController({ t: 'voice-status', s, detail }),
});
remote = createRemote({ link, hub, toast, onHome: showHome });
home = createHome({
  link,
  hub,
  toast,
  summary: () => roster.summary(),
  onTeleprompter: showLocal,
  onRemote: showRemote,
  onScripts() {
    showLocal();
    prompter.controls.openPanel('scripts');
  },
  onLogs: (where) => prompter.controls.openLogs(where),
});

function route() {
  const hash = location.hash;
  const screen = hash.startsWith('#/remote') ? 'remote' : hash.startsWith('#/home') ? 'home' : 'local';
  if (screen === 'remote') remote.enter();
  else remote.leave();
  if (screen === 'home') home.enter();
  else home.leave();
  // Remember which screen this device was last on, so it reopens there.
  const p = store.getPrefs();
  if (p.screen !== screen) {
    p.screen = screen;
    store.savePrefs(p);
  }
}
window.addEventListener('hashchange', route);

prompter.start();
// Cold start: reopen where this device was last (a remote goes straight back to
// controlling; the teleprompter device lands on its Scripts). First run: Home.
// Returning from the background doesn't re-run this, so a take is never interrupted.
const lastScreen = store.getPrefs().screen;
if (!location.hash) {
  if (lastScreen === 'remote' && store.getRemoteCode()) history.replaceState(null, '', '#/remote');
  else if (lastScreen !== 'local') history.replaceState(null, '', '#/home');
}
route();
if (!location.hash) prompter.controls.openPanel('scripts');
const splash = $('splash');
splash?.addEventListener('animationend', (e) => e.animationName === 'splash-out' && splash.remove());
setTimeout(() => splash?.remove(), 3500); // belt and braces

const remembered = store.getRemoteCode();
if (remembered) link.connect(remembered);

// First-run nudge and the iPhone install hint.
const prefs = store.getPrefs();
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (!prefs.seenTip) {
  prefs.seenTip = true;
  store.savePrefs(prefs);
  setTimeout(() => toast(isIOS && !standalone ? 'Tip: Share → Add to Home Screen to install' : 'Tap ⋯ → Connect to control another phone'), 1200);
}

// Updates. The app runs from an offline copy; check for a new version on launch and
// whenever it comes back to the front. A new version takes over right away if nothing is
// happening (just opened, not scrolling, no voice glide, not editing); otherwise it waits
// for the next launch so a take is never interrupted.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  let wokeAt = Date.now();
  let reloading = false;
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        wokeAt = Date.now();
        reg.update().catch(() => {});
      });
    })
    .catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // first install: nothing to swap
    const e = prompter.engine;
    const editing = !!document.querySelector('.editor:not([hidden])');
    if (Date.now() - wokeAt < 20000 && !e.playing && !e.voice && !editing) {
      reloading = true;
      location.reload();
    } else toast('Update downloaded. It applies next time you open the app.');
  });
}
