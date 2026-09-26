// Remote screen: controls another phone and mirrors its position in a live preview you
// can drag. Uses the same control bar/panel as the local screen, bound to the link.
import { mountControls } from './controls.js';
import { renderScript, measure, anchorAt, yForAnchor, fmtTime } from './render.js';
import * as lib from './library.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

export function createRemote({ link, hub, toast, onOpenLocal }) {
  const view = $('remote');
  const preview = $('r-preview');
  const pv = $('r-content');
  const padTop = $('r-padtop');
  const padBot = $('r-padbot');
  const pvCue = $('r-cue');
  const pill = $('r-pill');

  let targetSettings = { ...store.DEFAULT_SETTINGS };
  let ps = { playing: false, counting: 0, speed: 6, a: { p: 0, f: 0 }, progress: 0, remain: NaN, scriptId: null };
  let active = false;
  // What the teleprompter says about us (null until it does — older app versions never
  // send it, and then this phone simply has control as before).
  let rosterInfo = null;
  const inControl = () => link.connected && hub.role === 'remote' && (rosterInfo ? rosterInfo.you.control : true);
  // Why the controls are locked while connected, or null.
  function blocked() {
    if (!link.connected || inControl()) return null;
    if (hub.role === 'viewer') return 'Viewer mode — ⋯ → Connect to switch to Remote';
    return `${rosterInfo?.seat || 'Another phone'} is in control — ⋯ → Connect to take over`;
  }

  // Replies to requests (take logs) from the teleprompter.
  const waiting = new Map();
  function request(msg, replyType, ms = 10000) {
    return new Promise((resolve, reject) => {
      if (!link.connected) return reject(new Error('Not connected'));
      const key = replyType + (msg.id || '');
      clearTimeout(waiting.get(key)?.timer);
      const timer = setTimeout(() => {
        waiting.delete(key);
        reject(new Error('No answer. Update the app on the teleprompter phone.'));
      }, ms);
      waiting.set(key, { resolve, timer });
      link.send(msg);
    });
  }

  const send = (msg) => link.send(msg);
  const ctl = {
    local: false,
    link,
    ready: inControl,
    blocked,
    get settings() {
      return targetSettings;
    },
    get state() {
      return ps;
    },
    play: () => send({ t: 'play' }),
    pause: () => send({ t: 'pause' }),
    toggle: () => send({ t: 'toggle' }),
    top() {
      send({ t: 'top' });
      targetY = 0;
    },
    para: (dir) => send({ t: 'para', dir }),
    nudge: (lines) => send({ t: 'nudge', lines }),
    seekAnchor: (a, drag) => send({ t: 'seek', a, drag }),
    setSpeed(v) {
      targetSettings.speed = Math.max(1, Math.min(30, Math.round(v * 2) / 2));
      send({ t: 'speed', v: targetSettings.speed });
      controls.update();
    },
    setSetting(key, value) {
      targetSettings[key] = value;
      send({ t: 'setting', key, value });
      if (['lineHeight', 'align', 'cuePos', 'fontSize', 'margin'].includes(key)) layoutPreview();
      controls.update();
    },
    setVoice(on) {
      ps.voice = on;
      send({ t: 'voice', on });
    },
    select(id) {
      const why = blocked();
      if (why) return toast(why);
      ps.scriptId = id;
      send({ t: 'select', id });
      renderPreview(true);
      controls.update();
    },
    // Take logs live on the teleprompter phone; fetch them over the link.
    logs: {
      list: () => request({ t: 'getlogs' }, 'logs').then((m) => m.list || []),
      get: (id) => request({ t: 'getlog', id }, 'log', 30000).then((m) => m.data),
    },
  };
  const controls = mountControls({ root: view, ctl, hub, toast });

  // ================================================================ viewer mode
  // A viewer only watches: no control bar, no header, just the words full screen. A small
  // corner menu (fades when idle) opens the panel to switch back, plus full screen on
  // devices that allow it (laptops, not iPhone).
  const corner = document.createElement('div');
  corner.className = 'v-corner';
  corner.innerHTML = `<button data-v="menu" aria-label="Menu">⋯</button>${document.fullscreenEnabled ? '<button data-v="fs" aria-label="Full screen">⤢</button>' : ''}`;
  view.appendChild(corner);
  function toggleFullscreen() {
    try {
      const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
      p?.catch?.(() => {});
    } catch {}
  }
  corner.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    if (b.dataset.v === 'menu') controls.openPanel('connect');
    else toggleFullscreen();
  });
  let idleTimer = 0;
  function wake() {
    corner.classList.add('awake');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => corner.classList.remove('awake'), 3000);
  }
  view.addEventListener('pointermove', wake);
  view.addEventListener('pointerdown', wake);
  function applyRole() {
    const viewer = hub.role === 'viewer';
    if (view.classList.contains('viewer') !== viewer) {
      view.classList.toggle('viewer', viewer);
      if (active) requestAnimationFrame(() => layoutPreview());
    }
    if (viewer) wake();
  }

  // ================================================================ keyboard (laptop)
  document.addEventListener('keydown', (e) => {
    if (!active || e.target.matches('input, textarea')) return;
    if (view.querySelector('.sheet:not([hidden]), .modal')) return; // panel or editor open
    const k = e.key;
    if (k === 'f' || k === 'F') return toggleFullscreen();
    const act = {
      ' ': () => ctl.toggle(),
      Enter: () => ctl.toggle(),
      ArrowDown: () => ctl.nudge(1),
      ArrowUp: () => ctl.nudge(-1),
      ArrowRight: () => ctl.para(1),
      PageDown: () => ctl.para(1),
      ArrowLeft: () => ctl.para(-1),
      PageUp: () => ctl.para(-1),
      '+': () => ctl.setSpeed(targetSettings.speed + 0.5),
      '=': () => ctl.setSpeed(targetSettings.speed + 0.5),
      '-': () => ctl.setSpeed(targetSettings.speed - 0.5),
      Home: () => ctl.top(),
    }[k];
    if (!act) return;
    e.preventDefault();
    if (!inControl()) return blocked() && toast(blocked());
    act();
  });

  // ================================================================ preview
  let m = { tops: [], heights: [], total: 0, count: 0 };
  let displayY = 0;
  let targetY = 0;
  let lastProg = -1;
  let touching = false;
  let lastUser = 0;
  let lastSeekSent = 0;
  let pastIdx = -1;
  let raf = 0;
  let lastT = 0;
  // The preview is a scaled copy of the teleprompter screen: same font size relative to
  // the screen width, same margins, so lines wrap identically and "three lines down"
  // means the same thing on both phones.
  let pvFont = 21;
  const pvLineH = () => pvFont * targetSettings.lineHeight;
  const userActive = () => touching || performance.now() - lastUser < 700;

  function layoutPreview(keep = true) {
    const a = keep ? anchorAt(displayY, m) : { p: 0, f: 0 };
    const hgt = preview.clientHeight;
    if (!hgt) return;
    const scale = ps.w ? preview.clientWidth / ps.w : 0;
    pvFont = scale ? Math.max(8, targetSettings.fontSize * scale) : 21;
    pv.style.fontSize = pvFont + 'px';
    const pad = scale ? preview.clientWidth * (targetSettings.margin / 100) : 18;
    preview.style.paddingLeft = preview.style.paddingRight = Math.round(pad) + 'px';
    padTop.style.height = Math.round(hgt * targetSettings.cuePos) + 'px';
    padBot.style.height = Math.round(hgt * (1 - targetSettings.cuePos)) + 'px';
    pvCue.style.top = Math.round(hgt * targetSettings.cuePos) + 'px';
    pv.style.lineHeight = targetSettings.lineHeight;
    pv.style.textAlign = targetSettings.align;
    m = measure(pv);
    displayY = targetY = yForAnchor(a, m);
    setScroll(displayY);
    pastIdx = -1;
  }
  function renderPreview(resetPos) {
    const s = lib.get(ps.scriptId);
    renderScript(pv, s ? (s.text.trim() ? s.text : 'This script is empty. Tap the pencil to write it.') : link.connected ? 'Waiting for the teleprompter…' : 'Not connected.');
    $('r-title').textContent = s ? s.title || 'Untitled' : 'Remote';
    layoutPreview(!resetPos);
  }
  function setScroll(v) {
    preview.scrollTop = v;
    lastProg = preview.scrollTop;
  }

  preview.addEventListener('touchstart', () => (touching = true), { passive: true });
  const touchEnd = () => {
    touching = false;
    lastUser = performance.now();
  };
  preview.addEventListener('touchend', touchEnd, { passive: true });
  preview.addEventListener('touchcancel', touchEnd, { passive: true });
  preview.addEventListener('wheel', () => (lastUser = performance.now()), { passive: true });
  let mouseDrag = null;
  preview.addEventListener('mousedown', (e) => {
    mouseDrag = { y: e.clientY, top: preview.scrollTop, moved: false };
    touching = true;
  });
  window.addEventListener('mousemove', (e) => {
    if (!mouseDrag) return;
    const dy = e.clientY - mouseDrag.y;
    if (Math.abs(dy) > 4) mouseDrag.moved = true;
    if (mouseDrag.moved) preview.scrollTop = mouseDrag.top - dy;
  });
  window.addEventListener('mouseup', () => {
    if (!mouseDrag) return;
    preview.dataset.dragged = mouseDrag.moved ? '1' : '';
    mouseDrag = null;
    touchEnd();
  });
  preview.addEventListener(
    'scroll',
    () => {
      const st = preview.scrollTop;
      if (Math.abs(st - lastProg) < 2) return;
      lastUser = performance.now();
      displayY = targetY = st;
      lastProg = st;
      if (!inControl()) return;
      const now = performance.now();
      if (now - lastSeekSent > 33) {
        lastSeekSent = now;
        send({ t: 'seek', a: anchorAt(st, m), drag: true });
      }
      clearTimeout(preview._settle);
      preview._settle = setTimeout(() => send({ t: 'seek', a: anchorAt(preview.scrollTop, m), drag: true }), 120);
    },
    { passive: true }
  );
  pv.addEventListener('click', (e) => {
    if (preview.dataset.dragged) {
      preview.dataset.dragged = '';
      return;
    }
    const para = e.target.closest('.para');
    if (!para || para.classList.contains('blank')) return;
    if (!inControl()) return;
    const a = { p: +para.dataset.i, f: 0 };
    send({ t: 'seek', a, drag: false });
    targetY = yForAnchor(a, m);
    lastUser = 0;
    touching = false;
  });

  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - (lastT || t)) / 1000);
    lastT = t;
    if (userActive()) targetY = displayY = preview.scrollTop;
    else {
      if (ps.playing && link.connected) targetY += ps.speed * 0.1 * pvLineH() * dt;
      targetY = Math.max(0, Math.min(m.total, targetY));
      const k = 1 - Math.exp(-dt * 10);
      displayY += (targetY - displayY) * k;
      if (Math.abs(targetY - displayY) < 0.3) displayY = targetY;
      if (Math.abs(preview.scrollTop - displayY) >= 0.5) setScroll(displayY);
    }
    const p = anchorAt(displayY + 1, m).p;
    if (p !== pastIdx) {
      const kids = pv.children;
      for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('past', i < p);
      pastIdx = p;
    }
  }

  // ================================================================ link
  function linkStatus() {
    applyRole();
    const t = link.targetStatus;
    if (t !== 'connected') rosterInfo = null;
    const mode = hub.role === 'viewer' ? ' · Viewer' : rosterInfo && !rosterInfo.you.control ? ' · Waiting' : '';
    pill.className = 'pill ' + (t === 'connected' ? (mode ? 'view' : 'ok') : t === 'idle' ? '' : t === 'notfound' ? 'bad' : 'wait');
    pill.querySelector('span:last-child').textContent = { idle: 'Not connected', connecting: 'Connecting…', notfound: 'Not found', connected: link.targetCode + mode }[t] || t;
    if (t !== 'connected') {
      ps = { ...ps, playing: false, counting: 0 };
      if (active && t === 'idle') renderPreview(true);
    }
    controls.update();
  }
  pill.onclick = () => controls.openPanel('connect');
  $('r-back').onclick = () => onOpenLocal?.();

  new ResizeObserver(() => active && layoutPreview()).observe(preview);

  return {
    ctl,
    controls,
    linkStatus,
    get rosterInfo() {
      return rosterInfo;
    },
    onRoster(msg) {
      const had = rosterInfo;
      const was = inControl();
      rosterInfo = msg;
      const now = inControl();
      if (hub.role === 'remote' && was !== now) {
        if (now) toast(had ? 'You have control' : 'Connected: you have control');
        else toast(`${msg.seat || 'Another phone'} ${had ? 'took control' : 'is in control'}`);
      }
      linkStatus();
    },
    onReply(msg) {
      const key = msg.t + (msg.id || '');
      const w = waiting.get(key);
      if (!w) return;
      clearTimeout(w.timer);
      waiting.delete(key);
      w.resolve(msg);
    },
    onState(msg) {
      const scriptChanged = msg.scriptId !== ps.scriptId;
      const sizeChanged = msg.w !== ps.w || msg.h !== ps.h;
      ps = msg;
      if (scriptChanged) renderPreview(true);
      else if (sizeChanged) layoutPreview();
      if (!userActive()) targetY = yForAnchor(msg.a, m);
      $('r-progress').style.width = Math.round((msg.progress || 0) * 1000) / 10 + '%';
      $('r-left').textContent = fmtTime(msg.remain);
      const heard = $('r-heard');
      heard.hidden = !msg.voice;
      if (msg.voice) heard.textContent = msg.heard || 'Listening…';
      if (targetSettings.speed !== msg.speed) targetSettings.speed = msg.speed;
      controls.update();
    },
    onVoiceStatus(s, detail) {
      const heard = $('r-heard');
      if (s === 'blocked' || s === 'unsupported') {
        ps.voice = false;
        toast(`Teleprompter phone: ${detail || 'voice glide unavailable'}`);
        heard.hidden = true;
      } else if (s === 'listening') {
        heard.hidden = false;
        heard.textContent = 'Listening…';
      } else if (s === 'paused') heard.textContent = 'Paused (teleprompter phone in background)';
      controls.update();
    },
    onSettings(s) {
      targetSettings = { ...store.DEFAULT_SETTINGS, ...s };
      layoutPreview();
      controls.update();
    },
    onSelect(id) {
      ps.scriptId = id;
      renderPreview(true);
      controls.update();
    },
    scriptChanged(id) {
      if (id === ps.scriptId) renderPreview(false);
    },
    enter() {
      active = true;
      view.hidden = false;
      renderPreview(false);
      linkStatus();
      lastT = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    },
    leave() {
      active = false;
      view.hidden = true;
      controls.closePanel();
      controls.closePop();
      cancelAnimationFrame(raf);
    },
  };
}
