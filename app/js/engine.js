// Teleprompter engine: owns the script on screen, display settings, the scroll clock and
// the play/seek state. Runs on every phone. Remotes send it commands; it reports state.
import { renderScript, measure, anchorAt, yForAnchor, paraStep, THEMES } from './render.js';

export function createEngine({ view, stage, scroller, content, cue, countEl, settings, onState, onEvent }) {
  let script = null;
  let m = { tops: [], heights: [], total: 0, count: 0 };
  let y = 0;
  let seekTarget = null;
  let seekRate = 12;
  let playing = false;
  let countdownEnd = 0;
  let dragging = false;
  let raf = 0;
  let lastT = 0;
  let lastAppliedY = NaN;
  let dirty = true;
  let urgent = false;
  let voice = false; // voice glide drives position; auto-scroll stays off
  let heard = '';
  let lastEmit = 0;
  let emitKey = '';
  let lastPosLog = 0;
  let dragFrom = null;
  let wasMoving = false;
  const ev = (type, data) => onEvent?.(type, data);

  const cueY = () => stage.clientHeight * settings.cuePos;
  const lineH = () => settings.fontSize * settings.lineHeight;
  const pxPerSec = () => settings.speed * 0.1 * lineH();
  const clampY = (v) => Math.max(0, Math.min(m.total, v));

  function applySettings(next, keep = true) {
    const a = keep ? anchorAt(y, m) : null;
    Object.assign(settings, next);
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
    markDirty(true);
  }

  function remeasure(a = anchorAt(y, m)) {
    const pending = seekTarget != null ? anchorAt(seekTarget, m) : null; // keep an in-flight seek
    m = measure(content);
    y = clampY(yForAnchor(a, m));
    seekTarget = pending ? clampY(yForAnchor(pending, m)) : null;
    lastAppliedY = NaN;
  }

  function setScript(next, { resetPosition } = {}) {
    const a = resetPosition ? { p: 0, f: 0 } : anchorAt(y, m);
    script = next;
    renderScript(content, script?.text?.trim() ? script.text : 'This script is empty. Tap the pencil to write it.');
    remeasure(a);
    if (resetPosition) {
      y = 0;
      pause();
    }
    markDirty(true);
  }

  function play() {
    if (playing || countdownEnd) return;
    if (voice) setVoice(false);
    if (y >= m.total - 1) y = 0;
    ev('play', { countdown: settings.countdown > 0 ? settings.countdown : 0 });
    if (settings.countdown > 0) {
      countdownEnd = performance.now() + settings.countdown * 1000;
      countEl.hidden = false;
      countEl.textContent = settings.countdown;
    } else {
      playing = true;
      ev('rolling');
    }
    markDirty(true);
  }
  function pause() {
    if (playing || countdownEnd) ev('pause', { a: anchorAt(y, m) });
    playing = false;
    countdownEnd = 0;
    countEl.hidden = true;
    markDirty(true);
  }
  const toggle = () => (playing || countdownEnd ? pause() : play());

  function setSpeed(v) {
    const next = Math.max(1, Math.min(30, Math.round(v * 2) / 2));
    if (next !== settings.speed) ev('speed', { v: next });
    settings.speed = next;
    markDirty(true);
  }

  let onVoice = null;
  function setVoice(v) {
    v = !!v;
    if (v === voice) return;
    voice = v;
    ev('voice', { on: v });
    if (v) pause();
    heard = '';
    onVoice?.(v);
    markDirty(true);
  }

  // Manual moves are logged as jumps (voice glide moves are not; positions cover those).
  function jump(kind, target, rate) {
    const from = anchorAt(seekTarget ?? y, m);
    seekTo(target, rate);
    ev('jump', { kind, from, to: anchorAt(seekTarget, m) });
  }

  function seekTo(target, rate = 12) {
    seekTarget = clampY(target);
    seekRate = rate;
    markDirty();
  }

  function markDirty(now = false) {
    dirty = true;
    if (now) urgent = true;
  }

  function state() {
    const pps = pxPerSec();
    return {
      playing,
      counting: countdownEnd ? Math.max(1, Math.ceil((countdownEnd - performance.now()) / 1000)) : 0,
      speed: settings.speed,
      a: anchorAt(y, m),
      progress: m.total ? y / m.total : 0,
      remain: pps > 0 ? (m.total - y) / pps : 0,
      scriptId: script?.id || null,
      voice,
      heard: voice ? heard : '',
      // screen size so a remote can show a true-to-scale preview
      w: stage.clientWidth,
      h: stage.clientHeight,
    };
  }

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
        ev('rolling');
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
      ev('end');
      pause();
    }

    // Position trail for the take log: ~1/s while anything is moving, plus where it stopped.
    const moving = playing || dragging || seekTarget != null || voice;
    if ((moving && t - lastPosLog > 1000) || (!moving && wasMoving)) {
      lastPosLog = t;
      ev('pos', { a: anchorAt(y, m) });
    }
    wasMoving = moving;

    if (y !== lastAppliedY) {
      scroller.style.transform = `translate3d(0, ${(cueY() - y).toFixed(2)}px, 0)`;
      lastAppliedY = y;
      markDirty();
    }

    const interval = playing || dragging || seekTarget != null ? 90 : 250;
    if (urgent || (dirty && t - lastEmit > interval) || t - lastEmit > 1500) {
      const s = state();
      const key = `${s.playing}|${s.counting}|${s.speed}|${s.a.p}|${s.a.f.toFixed(3)}|${s.scriptId}|${s.voice}|${s.heard}`;
      if (urgent || key !== emitKey || t - lastEmit > 1500) {
        onState?.(s, urgent);
        emitKey = key;
      }
      lastEmit = t;
      dirty = false;
      urgent = false;
    }
  }

  return {
    get script() {
      return script;
    },
    get settings() {
      return settings;
    },
    get playing() {
      return playing || !!countdownEnd;
    },
    get voice() {
      return voice;
    },
    setVoice,
    set onVoice(fn) {
      onVoice = fn;
    },
    setHeard(t) {
      heard = String(t || '').slice(-60);
      ev('heard', { text: t });
      markDirty();
    },
    // voice glide: gentle move so the next words settle at the reading line
    glideTo: (a) => seekTo(yForAnchor(a, m), 5),
    get y() {
      return y;
    },
    state,
    applySettings,
    setScript,
    remeasure: () => remeasure(),
    play,
    pause,
    toggle,
    setSpeed,
    seekAnchor: (a, drag) => jump(drag ? 'drag' : 'tap', yForAnchor(a, m), drag ? 28 : 10),
    setAnchor(a) {
      y = clampY(yForAnchor(a, m));
      seekTarget = null;
      markDirty(true);
    },
    para: (dir) => jump('para', paraStep(seekTarget ?? y, m, content, dir), 9),
    nudge: (lines) => jump('nudge', (seekTarget ?? y) + lines * lineH(), 12),
    // Half a screen forward/back (keyboard ← →).
    page: (dir) => jump('page', (seekTarget ?? y) + dir * stage.clientHeight * 0.5, 9),
    top() {
      pause();
      jump('top', 0, 9);
    },
    // direct drag on the stage
    dragStart() {
      dragging = true;
      seekTarget = null;
      dragFrom = anchorAt(y, m);
      return y;
    },
    dragTo(v) {
      y = clampY(v);
      ev('jump', { kind: 'drag', from: dragFrom, to: anchorAt(y, m) });
      markDirty();
    },
    dragEnd() {
      dragging = false;
      markDirty(true);
    },
    anchor: () => anchorAt(y, m),
    poke: () => markDirty(true),
    start() {
      lastT = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(raf);
    },
  };
}
