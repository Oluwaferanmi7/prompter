import { createPrompter } from './prompter.js';
import { createRemote } from './remote.js';
import * as store from './store.js';
import { keepAwake } from './wakelock.js';

const $ = (id) => document.getElementById(id);

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

const goHome = () => {
  location.hash = '';
};

let prompter = null;
let remote = null;
let current = null;

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const name = h.startsWith('prompter') ? 'prompter' : h.startsWith('remote') ? 'remote' : 'home';
  if (name === current) return;
  if (current === 'prompter') prompter.leave();
  if (current === 'remote') remote.leave();
  $('home').hidden = name !== 'home';
  current = name;
  if (name === 'prompter') {
    prompter ||= createPrompter({ goHome, toast });
    prompter.enter();
  } else if (name === 'remote') {
    remote ||= createRemote({ goHome, toast });
    remote.enter();
  } else {
    markLastRole();
  }
}

function markLastRole() {
  const last = store.getLastRole();
  document.querySelectorAll('.role-card').forEach((c) => c.classList.toggle('last', c.dataset.role === last));
}

document.querySelectorAll('.role-card').forEach((btn) => {
  btn.addEventListener('click', () => {
    const role = btn.dataset.role;
    store.setLastRole(role);
    if (role === 'prompter') keepAwake(); // needs this user gesture on iOS
    location.hash = '#/' + role;
  });
});

// "Add to Home Screen" hint for iPhone Safari when not installed yet.
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS && !standalone) $('install-tip').hidden = false;

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
