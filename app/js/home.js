// Home: "What's this device doing?" Teleprompter, Remote or Viewer, plus Scripts and
// Take logs. Every mode's back button comes here. The app reopens in the last mode, so a
// remote phone goes straight back to controlling; Home is one tap away.
import * as lib from './library.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const ICON = {
  tele: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M7 9h10M7 12h7M9 21h6M12 17v4"/></svg>',
  remote: '<svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="3"/><path d="M11 6l3 2-3 2z" fill="currentColor"/><path d="M10 14h4M10 17h4"/></svg>',
  viewer: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
};

export function createHome({ link, hub, summary, toast, onTeleprompter, onScripts, onRemote, onLogs }) {
  const view = $('home');
  view.innerHTML = `
    <div class="home-in">
      <div class="home-brand"><img src="icons/ls-mark-gold.png" alt=""><span><b>LiM</b> Prompter</span></div>
      <h1 class="home-q">What's this device doing?</h1>
      <button class="mode" data-m="tele">
        <span class="m-ico">${ICON.tele}</span>
        <span class="m-txt"><b>Teleprompter</b><small data-sub="tele"></small></span><span class="m-go">›</span>
      </button>
      <button class="mode" data-m="remote">
        <span class="m-ico">${ICON.remote}</span>
        <span class="m-txt"><b>Remote</b><small data-sub="remote"></small></span><span class="m-go">›</span>
      </button>
      <button class="mode" data-m="viewer">
        <span class="m-ico">${ICON.viewer}</span>
        <span class="m-txt"><b>Viewer</b><small data-sub="viewer"></small></span><span class="m-go">›</span>
      </button>
      <div class="home-code-entry" hidden>
        <div class="set-sub" data-ask></div>
        <input class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="ABCD">
        <div class="status-line" data-err></div>
      </div>
      <div class="home-links">
        <button class="btn ghost small" data-l="scripts">Scripts</button>
        <button class="btn ghost small" data-l="logs">Take logs</button>
      </div>
      <div class="home-me">This device's code <b data-code></b><span data-status></span></div>
    </div>`;

  const entry = view.querySelector('.home-code-entry');
  const input = entry.querySelector('input');
  let pending = null; // 'remote' | 'viewer' waiting for a code

  function go(role) {
    hub.setRole(role);
    onRemote();
  }
  function askCode(role) {
    pending = role;
    entry.hidden = false;
    entry.querySelector('[data-ask]').textContent = `Enter the code shown on the teleprompter device to ${role === 'viewer' ? 'watch' : 'control'} it`;
    entry.querySelector('[data-err]').textContent = '';
    input.value = '';
    // Put the box right under the card that was tapped.
    view.querySelector(`[data-m=${role}]`).after(entry);
    setTimeout(() => input.focus(), 50);
  }
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (input.value.length < 4) return;
    const c = input.value;
    const err = entry.querySelector('[data-err]');
    if (!/^[A-HJ-KM-NP-Z2-9]{4}$/.test(c)) return (err.textContent = 'Codes are 4 letters/numbers, like K7QM.');
    if (c === link.code) return (err.textContent = "That's this device's own code.");
    store.setRemoteCode(c);
    link.connect(c);
    input.blur();
    entry.hidden = true;
    go(pending);
  });

  view.addEventListener('click', (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    const l = e.target.closest('[data-l]')?.dataset.l;
    const change = e.target.closest('[data-change]');
    if (change) {
      e.stopPropagation();
      return askCode(change.dataset.change);
    }
    if (m === 'tele') onTeleprompter();
    else if (m) {
      // Remote / Viewer: straight in if we know which device, otherwise ask for its code.
      if (link.targetCode) go(m);
      else askCode(m);
    } else if (l === 'scripts') onScripts();
    else if (l === 'logs') onLogs(view);
  });

  function refresh() {
    if (view.hidden) return;
    const s = lib.active();
    const n = link.controllerCount;
    view.querySelector('[data-sub=tele]').textContent = `This device shows the script${s ? ` · “${s.title || 'Untitled'}”` : ''}${n ? ` · ${summary()} connected` : ''}`;
    const t = link.targetCode;
    const st = link.targetStatus;
    const state = st === 'connected' ? `Connected to ${t}` : st === 'notfound' ? `${t} not found` : `${t} · connecting…`;
    for (const role of ['remote', 'viewer']) {
      const sub = view.querySelector(`[data-sub=${role}]`);
      const card = view.querySelector(`[data-m=${role}]`);
      card.classList.toggle('current', !!t && hub.role === role);
      if (!t) sub.textContent = role === 'remote' ? 'Control the teleprompter from this device' : 'Just the words, for the director or a laptop';
      else {
        sub.innerHTML = '';
        const mine = hub.role === role;
        const text = !mine ? `${role === 'remote' ? 'Control' : 'Watch'} ${t}` : st !== 'connected' ? state : role === 'remote' ? `Connected to ${t}` : `Watching ${t}`;
        sub.append(document.createTextNode(text));
        const ch = document.createElement('span');
        ch.className = 'm-change';
        ch.dataset.change = role;
        ch.textContent = 'Change';
        sub.append(' · ', ch);
      }
    }
    view.querySelector('[data-code]').textContent = link.code;
    view.querySelector('[data-status]').textContent = link.host === 'ready' ? '' : link.host === 'offline' ? ' · offline' : ' · starting…';
  }

  return {
    refresh,
    enter() {
      view.hidden = false;
      entry.hidden = true;
      refresh();
    },
    leave() {
      view.hidden = true;
    },
  };
}
