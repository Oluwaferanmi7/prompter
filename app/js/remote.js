// Remote screen: controls another phone and mirrors its position in a live preview you
// can drag. Uses the same control bar/panel as the local screen, bound to the link.
import { mountControls } from './controls.js';
import { renderScript, measure, anchorAt, yForAnchor, fmtTime } from './render.js';
import * as lib from './library.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

export function createRemote({ link, toast, onOpenLocal }) {
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

  const send = (msg) => link.send(msg);
  const ctl = {
    local: false,
    link,
    ready: () => link.connected,
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
      if (['lineHeight', 'align', 'cuePos'].includes(key)) layoutPreview();
      controls.update();
    },
    select(id) {
      ps.scriptId = id;
      send({ t: 'select', id });
      renderPreview(true);
      controls.update();
    },
  };
  const controls = mountControls({ root: view, ctl, toast });

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
  const pvLineH = () => 21 * targetSettings.lineHeight;
  const userActive = () => touching || performance.now() - lastUser < 700;

  function layoutPreview(keep = true) {
    const a = keep ? anchorAt(displayY, m) : { p: 0, f: 0 };
    const hgt = preview.clientHeight;
    if (!hgt) return;
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
    const t = link.targetStatus;
    pill.className = 'pill ' + (t === 'connected' ? 'ok' : t === 'idle' ? '' : t === 'notfound' ? 'bad' : 'wait');
    pill.querySelector('span:last-child').textContent = { idle: 'Not connected', connecting: 'Connecting…', notfound: 'Not found', connected: link.targetCode }[t] || t;
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
    onState(msg) {
      const scriptChanged = msg.scriptId !== ps.scriptId;
      ps = msg;
      if (scriptChanged) renderPreview(true);
      if (!userActive()) targetY = yForAnchor(msg.a, m);
      $('r-progress').style.width = Math.round((msg.progress || 0) * 1000) / 10 + '%';
      $('r-left').textContent = fmtTime(msg.remain);
      if (targetSettings.speed !== msg.speed) targetSettings.speed = msg.speed;
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
