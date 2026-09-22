import { Link } from './link.js';
import { createPrompter } from './prompter.js';
import { createRemote } from './remote.js';
import { applyMode } from './controls.js';
import * as lib from './library.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}

applyMode();

const settings = store.getSettings();
let prompter;
let remote;

// ------------------------------------------------------------------ link + protocol
const link = new Link({
  code: store.getMyCode(),
  onMessage: handle,
  onStatus: () => {
    prompter?.linkStatus();
    remote?.linkStatus();
  },
  onControllerChange(attached) {
    if (attached) {
      // A remote just took control: give it our library, display settings and position.
      link.sendToController({ t: 'sync', scripts: lib.raw(), settings: prompter.engine.settings, activeId: prompter.engine.script?.id });
      prompter.engine.poke();
      toast('Remote connected');
    }
    prompter?.linkStatus();
  },
  onOpen() {
    // We just connected to a teleprompter: swap libraries.
    link.send({ t: 'sync', scripts: lib.raw() });
    toast('Connected to teleprompter');
    remote?.linkStatus();
  },
});

let wasTarget = 'idle';
setInterval(() => {
  if (link.targetStatus !== wasTarget) {
    if (wasTarget === 'connected' && link.targetStatus === 'connecting') toast('Lost the teleprompter — reconnecting…');
    wasTarget = link.targetStatus;
  }
}, 500);

function handle(msg, from) {
  if (from === 'controller') {
    // Someone is controlling this phone.
    const e = prompter.engine;
    const c = prompter.ctl;
    switch (msg?.t) {
      case 'sync':
        lib.merge(msg.scripts, 'remote');
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
        lib.upsert(msg.script, 'remote');
        break;
    }
  } else {
    // We are controlling another phone.
    switch (msg?.t) {
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
    }
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
  }
});

// ------------------------------------------------------------------ screens
const showRemote = () => (location.hash = '#/remote');
const showLocal = () => (location.hash = '');

prompter = createPrompter({
  link,
  settings,
  toast,
  onOpenRemote: showRemote,
  onState: (s) => link.sendToController({ t: 'state', ...s }),
  onSettings: (s) => link.sendToController({ t: 'settings', settings: s }),
  onSelect: (id) => link.sendToController({ t: 'select', id }),
});
remote = createRemote({ link, toast, onOpenLocal: showLocal });

function route() {
  const wantRemote = location.hash.startsWith('#/remote');
  if (wantRemote) remote.enter();
  else remote.leave();
}
window.addEventListener('hashchange', route);

prompter.start();
route();

// Cold start lands on Scripts (pick one, or add a new one). Returning from the
// background doesn't re-run this, so a shoot in progress is never interrupted.
if (!location.hash.startsWith('#/remote')) prompter.controls.openPanel('scripts');
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

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
