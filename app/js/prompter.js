// This phone's teleprompter screen: the mirrored stage, the control bar and panel.
// Always running — a remote is optional and losing it never touches the script.
import { createEngine } from './engine.js';
import { mountControls } from './controls.js';
import * as lib from './library.js';
import * as store from './store.js';
import { keepAwake } from './wakelock.js';
import { createVoice } from './voice.js';

const $ = (id) => document.getElementById(id);

export function createPrompter({ link, settings, toast, onOpenRemote, onState, onSettings, onSelect }) {
  const view = $('prompter');
  const stage = $('p-stage');
  const hudTop = $('p-top');
  const remoteChip = $('p-remote');
  const ctrlDot = $('p-ctrl');

  const engine = createEngine({
    view,
    stage,
    scroller: $('p-scroller'),
    content: $('p-content'),
    cue: $('p-cue'),
    countEl: $('p-count'),
    settings,
    onState: (s, urgent) => {
      onState?.(s, urgent);
      controls.update();
      if (!s.playing) savePosSoon();
    },
  });

  // ------------------------------------------------------------------ voice glide
  const heardEl = $('p-heard');
  const voice = createVoice({
    onMove: (a) => engine.glideTo(a),
    onStatus: (s, detail) => {
      heardEl.dataset.status = s;
      if (s === 'blocked' || s === 'unsupported') {
        engine.setVoice(false);
        toast(detail || 'Voice glide unavailable');
      } else if (s === 'listening' && !heardEl.textContent) heardEl.textContent = 'Listening…';
      controls.update();
    },
    onHeard: (t) => {
      engine.setHeard(t);
      heardEl.textContent = t || 'Listening…';
    },
  });
  if (store.NS) window.__voice = voice; // test bench hook
  engine.onVoice = (on) => {
    heardEl.hidden = !on;
    heardEl.textContent = on ? 'Starting…' : '';
    if (on) {
      voice.setScript(engine.script?.text);
      voice.setCursorNear(engine.anchor());
      voice.enable();
    } else voice.disable();
    controls.update();
  };
  // After any manual move, point the matcher at the new spot.
  let resyncTimer = 0;
  function voiceResync() {
    if (!engine.voice) return;
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => voice.setCursorNear(engine.anchor()), 450);
  }

  // Local controller: the shared control UI talks to the engine directly.
  const ctl = {
    local: true,
    link,
    ready: () => true,
    get settings() {
      return engine.settings;
    },
    get state() {
      return engine.state();
    },
    play: () => engine.play(),
    pause: () => engine.pause(),
    toggle: () => engine.toggle(),
    top() {
      engine.top();
      voiceResync();
    },
    para(d) {
      engine.para(d);
      voiceResync();
    },
    nudge(n) {
      engine.nudge(n);
      voiceResync();
    },
    seekAnchor(a, drag) {
      engine.seekAnchor(a, drag);
      voiceResync();
    },
    setVoice: (on) => engine.setVoice(on),
    setSpeed(v) {
      engine.setSpeed(v);
      store.saveSettings(engine.settings);
      onSettings?.(engine.settings);
    },
    setSetting(key, value) {
      engine.applySettings({ [key]: value });
      store.saveSettings(engine.settings);
      onSettings?.(engine.settings);
      controls.update();
    },
    select(id, { fromRemote } = {}) {
      const s = lib.get(id);
      if (!s) return;
      lib.setActiveId(id);
      engine.setScript(s, { resetPosition: true });
      if (engine.voice) {
        voice.setScript(s.text);
        voice.setCursorNear({ p: 0, f: 0 });
      }
      if (!fromRemote) onSelect?.(id);
      controls.update();
    },
    onBarPref: (v) => setBar(v),
  };

  const controls = mountControls({ root: view, ctl, toast, onOpenRemote });

  // ------------------------------------------------------------------ bar visibility
  let barTimer = 0;
  function setBar(show, temporary = false) {
    controls.bar.classList.toggle('hidden', !show);
    hudTop.classList.toggle('hidden', !show);
    clearTimeout(barTimer);
    if (show && temporary) barTimer = setTimeout(() => setBar(false), 5000);
  }
  function tapStage() {
    const prefShow = store.getPrefs().showBar;
    const visible = !controls.bar.classList.contains('hidden');
    if (visible) setBar(false);
    else setBar(true, !prefShow);
  }

  // ------------------------------------------------------------------ touch on the stage
  let pDown = null;
  stage.addEventListener('pointerdown', (e) => {
    keepAwake();
    pDown = { y: e.clientY, startY: engine.y, moved: false, id: e.pointerId };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pDown || e.pointerId !== pDown.id) return;
    const dy = e.clientY - pDown.y;
    if (!pDown.moved && Math.abs(dy) > 8) {
      pDown.moved = true;
      pDown.startY = engine.dragStart();
    }
    if (pDown.moved) engine.dragTo(pDown.startY - dy * (engine.settings.mirrorY ? -1 : 1));
  });
  const endPointer = (e) => {
    if (!pDown || e.pointerId !== pDown.id) return;
    const wasTap = !pDown.moved;
    if (pDown.moved) {
      engine.dragEnd();
      voiceResync();
    }
    pDown = null;
    if (wasTap && e.type === 'pointerup') {
      if (controls.panelOpen) return;
      controls.closePop();
      tapStage();
    }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  view.addEventListener('pointerdown', () => keepAwake(), { capture: true });

  // Keyboard + Bluetooth page-turner / presentation clickers.
  document.addEventListener('keydown', (e) => {
    if (view.hidden || e.target.matches('input, textarea')) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter' || k === 'MediaPlayPause') engine.toggle();
    else if (k === 'ArrowDown') engine.nudge(1);
    else if (k === 'ArrowUp') engine.nudge(-1);
    else if (k === 'PageDown' || k === 'ArrowRight') engine.para(1);
    else if (k === 'PageUp' || k === 'ArrowLeft') engine.para(-1);
    else if (k === '+' || k === '=') ctl.setSpeed(engine.settings.speed + 0.5);
    else if (k === '-' || k === '_') ctl.setSpeed(engine.settings.speed - 0.5);
    else if (k === 'Home') engine.top();
    else return;
    e.preventDefault();
  });

  new ResizeObserver(() => !view.hidden && engine.remeasure()).observe(stage);
  remoteChip.onclick = () => onOpenRemote?.();

  // ------------------------------------------------------------------ position memory
  let posTimer = 0;
  function savePosSoon() {
    clearTimeout(posTimer);
    posTimer = setTimeout(() => engine.script && store.savePos({ id: engine.script.id, a: engine.anchor() }), 600);
  }
  window.addEventListener('pagehide', () => engine.script && store.savePos({ id: engine.script.id, a: engine.anchor() }));

  // ------------------------------------------------------------------ link status chips
  function linkStatus() {
    const t = link.targetStatus;
    remoteChip.hidden = t === 'idle';
    remoteChip.className = 'chip ' + (t === 'connected' ? 'ok' : t === 'notfound' ? 'bad' : 'wait');
    remoteChip.querySelector('span').textContent = t === 'connected' ? `Remote ${link.targetCode}` : t === 'notfound' ? `${link.targetCode} not found` : `Connecting ${link.targetCode}…`;
    ctrlDot.hidden = !link.hasController;
    controls.update();
  }

  return {
    engine,
    ctl,
    controls,
    linkStatus,
    voiceResync,
    // Called when a script in the library changes (local edit, remote edit or merge).
    scriptChanged(id) {
      if (engine.script && id === engine.script.id) {
        const s = lib.get(id);
        if (s) {
          engine.setScript(s, { resetPosition: false });
          if (engine.voice) {
            voice.setScript(s.text);
            voice.setCursorNear(engine.anchor());
          }
        } else ctl.select(lib.all()[0].id);
      }
    },
    start() {
      engine.applySettings({}, false);
      const pos = store.getPos();
      const first = (pos && lib.get(pos.id)) || lib.active() || lib.all()[0];
      lib.setActiveId(first.id);
      engine.setScript(first, { resetPosition: true });
      if (pos && pos.id === first.id) engine.setAnchor(pos.a);
      setBar(store.getPrefs().showBar);
      engine.start();
    },
  };
}
