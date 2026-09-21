// Teleprompter display (the phone inside the Desview).
// It owns the scroll clock: auto-scroll runs here at display refresh rate so it stays
// smooth regardless of network jitter. The remote sends commands + seek anchors; this
// side streams its position back so the remote's preview follows.
import { PrompterHost } from './link.js';
import { renderScript, measure, anchorAt, yForAnchor, paraStep, THEMES } from './render.js';
import * as store from './store.js';
import { keepAwake } from './wakelock.js';

const $ = (id) => document.getElementById(id);

export function createPrompter({ goHome, toast }) {
  const view = $('prompter');
  const stage = $('p-stage');
  const scroller = $('p-scroller');
  const content = $('p-content');
  const cue = $('p-cue');
  const countEl = $('p-count');
  const pair = $('p-pair');
  const codeEl = $('p-code');
  const statusEl = $('p-status');
  const dot = $('p-dot');
  const hud = $('p-hud');

  const cache = store.getPrompterCache();
  let script = cache?.script || null;
  let settings = { ...store.DEFAULT_SETTINGS, ...(cache?.settings || {}) };
  let m = { tops: [], heights: [], total: 0, count: 0 };
  let y = 0;
  let seekTarget = null;
  let seekRate = 12;
  let playing = false;
  let countdownEnd = 0;
  let dragging = false;
  let active = false;
  let raf = 0;
  let lastT = 0;
  let lastAppliedY = NaN;
  let lastSent = 0;
  let sentKey = '';
  let everConnected = false;
  let pairHiddenByUser = false;
  let disconnectedSince = Date.now();
  let hudTimer = 0;

  const link = new PrompterHost({ onMessage: handle, onStatus: onLinkStatus });

  // ------------------------------------------------------------ layout
  const cueY = () => stage.clientHeight * settings.cuePos;
  const lineH = () => settings.fontSize * settings.lineHeight;
  const pxPerSec = () => settings.speed * 0.1 * lineH();

  function applySettings(next, keep = true) {
    const a = keep ? anchorAt(y, m) : null;
    settings = { ...settings, ...next };
    const th = THEMES[settings.theme] || THEMES.white;
    const s = view.style;
    s.setProperty('--p-size', settings.fontSize + 'px');
    s.setProperty('--p-lh', settings.lineHeight);
    s.setProperty('--p-margin', settings.margin);
    s.setProperty('--p-align', settings.align);
    s.setProperty('--p-cue', settings.cuePos);
    s.setProperty('--p-fg', th.fg);
    s.setProperty('--p-bg', th.bg);
    s.setProperty('--p-cuecolor', th.cue);
    s.setProperty('--mx', settings.mirrorX ? -1 : 1);
    s.setProperty('--my', settings.mirrorY ? -1 : 1);
    cue.classList.toggle('hide', !settings.showCue);
    remeasure(a);
    $('h-speed').textContent = settings.speed.toFixed(1);
  }

  function remeasure(a = anchorAt(y, m)) {
    m = measure(content);
    y = clampY(yForAnchor(a, m));
    if (seekTarget != null) seekTarget = null;
    lastAppliedY = NaN;
  }

  function setScript(next, { resetPosition }) {
    const a = resetPosition ? { p: 0, f: 0 } : anchorAt(y, m);
    script = next;
    renderScript(content, script?.text?.trim() ? script.text : 'Waiting for a script from the remote…');
    remeasure(a);
    if (resetPosition) {
      y = 0;
      pause();
    }
    saveCacheSoon();
  }

  const clampY = (v) => Math.max(0, Math.min(m.total, v));

  // ------------------------------------------------------------ playback
  function play() {
    if (playing || countdownEnd) return;
    if (y >= m.total - 1) y = 0; // at the end → start over
    if (settings.countdown > 0) {
      countdownEnd = performance.now() + settings.countdown * 1000;
      countEl.hidden = false;
    } else playing = true;
    hidePairOverlay();
    markDirty(true);
  }
  function pause() {
    playing = false;
    countdownEnd = 0;
    countEl.hidden = true;
    markDirty(true);
    saveCacheSoon();
  }
  const toggle = () => (playing || countdownEnd ? pause() : play());

  function setSpeed(v) {
    settings.speed = Math.max(1, Math.min(30, Math.round(v * 2) / 2));
    $('h-speed').textContent = settings.speed.toFixed(1);
    markDirty(true);
    saveCacheSoon();
  }

  function seekTo(target, rate = 12) {
    seekTarget = clampY(target);
    seekRate = rate;
    markDirty();
  }

  // ------------------------------------------------------------ frame loop
  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - (lastT || t)) / 1000);
    lastT = t;

    if (countdownEnd) {
      const left = Math.ceil((countdownEnd - t) / 1000);
      if (left <= 0) {
        countdownEnd = 0;
        countEl.hidden = true;
        playing = true;
        markDirty(true);
      } else if (countEl.textContent !== String(left)) {
        countEl.textContent = left;
        markDirty(true);
      }
    }

    if (playing && !dragging) {
      const adv = pxPerSec() * dt;
      y += adv;
      if (seekTarget != null) seekTarget += adv;
    }
    if (seekTarget != null && !dragging) {
      const k = 1 - Math.exp(-dt * seekRate);
      y += (seekTarget - y) * k;
      if (Math.abs(seekTarget - y) < 0.5) {
        y = seekTarget;
        seekTarget = null;
      }
    }
    y = clampY(y);
    if (playing && y >= m.total && seekTarget == null) {
      pause();
      toast?.('End of script');
    }

    if (y !== lastAppliedY) {
      scroller.style.transform = `translate3d(0, ${(cueY() - y).toFixed(2)}px, 0)`;
      lastAppliedY = y;
      markDirty();
    }
    maybeSend(t);
  }

  // ------------------------------------------------------------ state → remote
  let dirty = true;
  let urgent = false;
  function markDirty(now = false) {
    dirty = true;
    if (now) urgent = true;
  }
  function stateMsg() {
    const pps = pxPerSec();
    return {
      t: 'state',
      playing,
      counting: countdownEnd ? Math.max(1, Math.ceil((countdownEnd - performance.now()) / 1000)) : 0,
      speed: settings.speed,
      a: anchorAt(y, m),
      progress: m.total ? y / m.total : 0,
      remain: pps > 0 ? (m.total - y) / pps : 0,
      scriptId: script?.id || null,
    };
  }
  function maybeSend(t) {
    if (!link.connected) return;
    const interval = playing || dragging || seekTarget != null ? 90 : 250;
    if (!(urgent || (dirty && t - lastSent > interval) || t - lastSent > 1500)) return;
    const msg = stateMsg();
    const key = `${msg.playing}|${msg.counting}|${msg.speed}|${msg.a.p}|${msg.a.f.toFixed(3)}|${msg.scriptId}`;
    if (key !== sentKey || t - lastSent > 1500) {
      link.send(msg);
      sentKey = key;
    }
    lastSent = t;
    dirty = false;
    urgent = false;
  }

  // ------------------------------------------------------------ messages
  function handle(msg) {
    switch (msg?.t) {
      case 'hello':
        urgent = true;
        break;
      case 'load': {
        const incoming = msg.script;
        const same = script && incoming && incoming.id === script.id;
        if (msg.settings) applySettings(msg.settings);
        if (!same || incoming.text !== script.text) setScript(incoming, { resetPosition: !same });
        else if (incoming.title !== script.title) script = incoming;
        urgent = true;
        break;
      }
      case 'text':
        if (script && msg.id === script.id) setScript({ ...script, title: msg.title, text: msg.text }, { resetPosition: false });
        break;
      case 'settings':
        applySettings(msg.settings);
        saveCacheSoon();
        urgent = true;
        break;
      case 'play':
        play();
        break;
      case 'pause':
        pause();
        break;
      case 'toggle':
        toggle();
        break;
      case 'speed':
        setSpeed(msg.v);
        break;
      case 'seek':
        seekTo(yForAnchor(msg.a, m), msg.drag ? 28 : 10);
        break;
      case 'para':
        seekTo(paraStep(seekTarget ?? y, m, content, msg.dir), 9);
        break;
      case 'nudge':
        seekTo((seekTarget ?? y) + msg.lines * lineH(), 12);
        break;
      case 'top':
        pause();
        seekTo(0, 9);
        break;
    }
  }

  function onLinkStatus(status, detail) {
    const connected = status === 'connected';
    statusEl.className = 'p-status' + (connected ? ' ok' : status === 'offline' ? ' bad' : '');
    statusEl.textContent =
      detail ||
      {
        starting: 'Getting ready…',
        waiting: 'Waiting for remote…',
        connected: 'Remote connected',
        offline: 'No internet — retrying…',
      }[status] ||
      status;
    dot.className = 'p-dot' + (connected ? ' ok' : status === 'offline' ? ' bad' : '');
    if (connected) {
      if (!everConnected) toast?.('Remote connected');
      everConnected = true;
      hidePairOverlay();
      urgent = true;
    } else {
      disconnectedSince = Date.now();
    }
  }

  // Show the pairing card when nothing is connected and we're not mid-take. After a
  // brief blip we wait a few seconds so the card doesn't flash over the script.
  setInterval(() => {
    if (!active) return;
    const shouldShow =
      !link.connected && !playing && !countdownEnd && !pairHiddenByUser && (!everConnected || Date.now() - disconnectedSince > 6000);
    if (shouldShow && pair.hidden) pair.hidden = false;
  }, 1000);

  function hidePairOverlay() {
    pair.hidden = true;
  }

  // ------------------------------------------------------------ local touch control
  let pDown = null;
  view.addEventListener('pointerdown', (e) => {
    keepAwake();
    if (e.target.closest('.p-hud, .p-pair-card')) return;
    pDown = { x: e.clientX, y: e.clientY, startY: y, moved: false, id: e.pointerId };
  });
  view.addEventListener('pointermove', (e) => {
    if (!pDown || e.pointerId !== pDown.id) return;
    const dy = e.clientY - pDown.y;
    if (!pDown.moved && Math.abs(dy) > 8) {
      pDown.moved = true;
      dragging = true;
      seekTarget = null;
    }
    if (pDown.moved) {
      y = clampY(pDown.startY - dy * (settings.mirrorY ? -1 : 1));
      markDirty();
    }
  });
  const endPointer = (e) => {
    if (!pDown || e.pointerId !== pDown.id) return;
    const wasTap = !pDown.moved;
    pDown = null;
    dragging = false;
    markDirty(true);
    if (wasTap && e.type === 'pointerup') {
      if (!pair.hidden) return;
      showHud();
    }
  };
  view.addEventListener('pointerup', endPointer);
  view.addEventListener('pointercancel', endPointer);

  function showHud() {
    hud.hidden = false;
    $('h-play').textContent = playing || countdownEnd ? '❚❚' : '▶︎';
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => (hud.hidden = true), 4000);
  }
  hud.addEventListener('pointerdown', () => {
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => (hud.hidden = true), 4000);
  });
  $('h-exit').onclick = () => goHome();
  $('h-pair').onclick = () => {
    pairHiddenByUser = false;
    pair.hidden = false;
    hud.hidden = true;
  };
  $('h-slower').onclick = () => setSpeed(settings.speed - 0.5);
  $('h-faster').onclick = () => setSpeed(settings.speed + 0.5);
  $('h-play').onclick = () => {
    toggle();
    $('h-play').textContent = playing || countdownEnd ? '❚❚' : '▶︎';
  };
  $('h-top').onclick = () => {
    pause();
    seekTo(0, 9);
  };
  $('p-hidepair').onclick = () => {
    pairHiddenByUser = true;
    hidePairOverlay();
  };
  $('p-newcode').onclick = () => {
    const c = store.newCode();
    store.setPrompterCode(c);
    codeEl.textContent = c;
    link.changeCode(c);
  };

  // Keyboard + Bluetooth page-turner / presentation clickers.
  document.addEventListener('keydown', (e) => {
    if (!active) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter' || k === 'MediaPlayPause') toggle();
    else if (k === 'ArrowDown') seekTo((seekTarget ?? y) + lineH(), 12);
    else if (k === 'ArrowUp') seekTo((seekTarget ?? y) - lineH(), 12);
    else if (k === 'PageDown' || k === 'ArrowRight') seekTo(paraStep(seekTarget ?? y, m, content, 1), 9);
    else if (k === 'PageUp' || k === 'ArrowLeft') seekTo(paraStep(seekTarget ?? y, m, content, -1), 9);
    else if (k === '+' || k === '=') setSpeed(settings.speed + 0.5);
    else if (k === '-' || k === '_') setSpeed(settings.speed - 0.5);
    else if (k === 'Home') seekTo(0, 9);
    else return;
    e.preventDefault();
  });

  new ResizeObserver(() => active && remeasure()).observe(stage);

  // ------------------------------------------------------------ persistence
  let cacheTimer = 0;
  function saveCacheSoon() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => store.savePrompterCache({ script, settings, a: anchorAt(y, m) }), 800);
  }
  window.addEventListener('pagehide', () => active && store.savePrompterCache({ script, settings, a: anchorAt(y, m) }));

  // ------------------------------------------------------------ lifecycle
  let started = false;
  return {
    enter() {
      active = true;
      view.hidden = false;
      applySettings(settings, false);
      if (!started) {
        started = true;
        setScript(script, { resetPosition: false });
        y = clampY(yForAnchor(cache?.a, m));
        const code = store.getPrompterCode();
        codeEl.textContent = code;
        link.start(code);
      } else remeasure();
      pair.hidden = link.connected || pairHiddenByUser;
      lastT = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    },
    leave() {
      active = false;
      pause();
      view.hidden = true;
      hud.hidden = true;
      cancelAnimationFrame(raf);
    },
  };
}
