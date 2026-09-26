// Take log: a timestamped diary of what happened on this teleprompter during a shoot, so
// the editor can line it up with the recording (a scroll back = a retake, a mid-shoot
// script edit = a standing rule, voice position = which line was being read).
//
// Runs on the phone showing the script. Nothing to press: a session starts on the first
// real activity and continues until 20 minutes of quiet (a reload mid-shoot keeps the same
// session). Sessions are kept on the phone and exported as JSON from Scripts → Take logs,
// on this phone or from a connected remote.
//
// Export format (format: 1) — times are Unix ms on THIS phone's clock:
//   scripts: { [id]: { title, versions: [{ t, text }] } }   every version seen this session
//   events:  [{ t, e, by?, ... }]                            by = 'local' or the remote's code
//     session  {script, settings}          session started
//     play     {countdown}                 play pressed (countdown seconds, 0 = none)
//     rolling  {}                          scrolling actually started (after countdown)
//     pause    {a, w}                      stopped (pressed, or script changed), and where
//     end      {}                          reached the end of the script
//     speed    {v}                         scroll speed changed
//     jump     {kind, from, to, dir, fw, tw}  manual move; kind: para | nudge | top | tap | drag
//     pos      {a, w}                      position at the reading line, ~1/s while moving
//     voice    {on}                        voice glide switched on/off
//     heard    {text}                      what voice glide heard (throttled)
//     script   {id, v}                     script shown (v = version index in scripts[id])
//     edit     {id, v}                     the shown script was edited (new version v)
//     phone    {code, on, role}            a phone connected / left
//     control  {code}                      control moved to this phone (take over)
//     hidden / visible                     app went to the background / came back
//   Positions: a = [paragraph, fraction 0..1], w/fw/tw = word index in the script (approx).
//   Paragraphs are the script's lines (split on "\n"), numbered from 0.
import { NS } from './store.js';

const INDEX = NS + 'tp.logs';
const ITEM = (id) => NS + 'tp.log.' + id;
const GAP = 20 * 60 * 1000; // quiet time that ends a session
const KEEP = 12; // sessions kept on the phone
const QUIET = new Set(['hidden', 'visible', 'phone', 'control']); // don't start a session on their own

const words = (s) => (String(s || '').match(/\S+/g) || []).length;
const round3 = (n) => Math.round((n || 0) * 1000) / 1000;
const read = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};

export function createTakeLog({ code }) {
  let cur = null; // { id, started, last, scripts, events }
  let actor = 'local';
  let shown = null; // { id, title, text } currently on screen
  let wordStarts = []; // word index at the start of each paragraph of `shown`
  let flushTimer = 0;
  let editTimer = 0;
  let drag = null; // pending coalesced drag
  let lastHeard = 0;
  let playBy = 'local';

  // Resume a recent session after a reload.
  const idx = read(INDEX, []);
  const last = idx[idx.length - 1];
  if (last && Date.now() - last.ended < GAP) {
    const data = read(ITEM(last.id), null);
    if (data) cur = { id: last.id, started: last.started, last: last.ended, scripts: data.scripts || {}, events: data.events || [] };
  }

  function wordAt(a) {
    if (!a || !wordStarts.length) return 0;
    const p = Math.min(wordStarts.length - 1, Math.max(0, a.p | 0));
    const n = (wordStarts[p + 1] ?? wordStarts[p]) - wordStarts[p];
    return wordStarts[p] + Math.round((a.f || 0) * n);
  }
  const A = (a) => (a ? [a.p | 0, round3(a.f)] : [0, 0]);

  function version(s) {
    // Record this text as a version of the script; returns its index.
    const rec = (cur.scripts[s.id] ||= { title: s.title || 'Untitled', versions: [] });
    rec.title = s.title || rec.title;
    const vs = rec.versions;
    if (vs.length && vs[vs.length - 1].text === s.text) return vs.length - 1;
    vs.push({ t: Date.now(), text: s.text });
    return vs.length - 1;
  }

  function ensure(type) {
    const now = Date.now();
    if (cur && now - cur.last < GAP) return true;
    if (QUIET.has(type)) return false;
    flushDrag();
    cur = { id: new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15) + '-' + code, started: now, last: now, scripts: {}, events: [] };
    const v = shown ? version(shown) : 0;
    cur.events.push({ t: now, e: 'session', script: shown?.id || null, v, settings: settingsSnap?.() || null });
    saveIndex();
    return true;
  }

  function push(type, data = {}) {
    if (!ensure(type)) return;
    const who = !QUIET.has(type) && type !== 'pos' && type !== 'heard' ? { by: actor } : {};
    const ev = { t: Date.now(), e: type, ...who, ...data };
    cur.events.push(ev);
    cur.last = ev.t;
    scheduleFlush();
  }

  function flushDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    clearTimeout(d.timer);
    if (Math.abs(d.tw - d.fw) < 1 && d.from[0] === d.to[0] && Math.abs(d.from[1] - d.to[1]) < 0.02) return; // no real move
    push('jump', { kind: 'drag', from: d.from, to: d.to, dir: d.tw < d.fw ? 'back' : 'fwd', fw: d.fw, tw: d.tw, by: d.by });
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 5000);
  }
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (!cur) return;
    const data = JSON.stringify({ scripts: cur.scripts, events: cur.events });
    for (let tries = 0; tries < KEEP; tries++) {
      try {
        localStorage.setItem(ITEM(cur.id), data);
        break;
      } catch {
        if (!dropOldest()) break; // storage full: make room and retry
      }
    }
    saveIndex();
  }
  function saveIndex() {
    let list = read(INDEX, []).filter((s) => s.id !== cur.id);
    const titles = Object.values(cur.scripts).map((s) => s.title);
    list.push({ id: cur.id, started: cur.started, ended: cur.last, titles, count: cur.events.length });
    while (list.length > KEEP) {
      const old = list.shift();
      try {
        localStorage.removeItem(ITEM(old.id));
      } catch {}
    }
    try {
      localStorage.setItem(INDEX, JSON.stringify(list));
    } catch {}
  }
  function dropOldest() {
    const list = read(INDEX, []);
    const old = list.find((s) => s.id !== cur?.id);
    if (!old) return false;
    try {
      localStorage.removeItem(ITEM(old.id));
      localStorage.setItem(INDEX, JSON.stringify(list.filter((s) => s !== old)));
    } catch {}
    return true;
  }

  let settingsSnap = null;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      push('hidden');
      flushDrag();
      flush();
    } else push('visible');
  });
  window.addEventListener('pagehide', () => {
    flushDrag();
    flush();
  });

  return {
    set actor(v) {
      actor = v || 'local';
    },
    get actor() {
      return actor;
    },
    // Function returning the current display settings (snapshotted at session start).
    set settings(fn) {
      settingsSnap = fn;
    },

    // The script on screen changed (selected, or first shown).
    show(s, { edited = false } = {}) {
      const changed = !shown || shown.id !== s.id;
      shown = { id: s.id, title: s.title, text: s.text };
      wordStarts = [];
      let n = 0;
      for (const line of String(s.text || '').replace(/\r\n?/g, '\n').split('\n')) {
        wordStarts.push(n);
        n += words(line);
      }
      wordStarts.push(n);
      if (edited && !changed) {
        // Typing fires many updates; record the text once it settles.
        const by = actor;
        clearTimeout(editTimer);
        editTimer = setTimeout(() => {
          if (!cur || shown.id !== s.id) return;
          const prev = actor;
          actor = by;
          const v = version(shown);
          const last = [...cur.events].reverse().find((e) => e.e === 'edit' || e.e === 'script' || e.e === 'session');
          if (!(last && (last.script ?? last.id) === s.id && last.v === v)) push('edit', { id: s.id, v });
          actor = prev;
        }, 2500);
      } else if (changed && cur && Date.now() - cur.last < GAP) {
        push('script', { id: s.id, v: version(shown) });
      }
    },

    event(type, data = {}) {
      if (type === 'jump' && data.kind === 'drag') {
        // A drag is a stream of seeks: keep one jump per gesture.
        const to = A(data.to);
        const tw = wordAt(data.to);
        if (drag && drag.by === actor) {
          drag.to = to;
          drag.tw = tw;
        } else {
          flushDrag();
          drag = { from: A(data.from), fw: wordAt(data.from), to, tw, by: actor };
        }
        clearTimeout(drag.timer);
        drag.timer = setTimeout(flushDrag, 600);
        return;
      }
      flushDrag();
      if (type === 'jump') {
        const fw = wordAt(data.from);
        const tw = wordAt(data.to);
        if (fw === tw && data.kind !== 'top') return;
        push('jump', { kind: data.kind, from: A(data.from), to: A(data.to), dir: tw < fw ? 'back' : 'fwd', fw, tw });
      } else if (type === 'pos') {
        if (!cur || Date.now() - cur.last >= GAP) return; // positions alone don't start a session
        push('pos', { a: A(data.a), w: wordAt(data.a) });
      } else if (type === 'heard') {
        const now = Date.now();
        if (!data.text || now - lastHeard < 1000) return;
        lastHeard = now;
        push('heard', { text: String(data.text).slice(-80) });
      } else if (data.a) push(type, { ...data, a: A(data.a), w: wordAt(data.a) });
      else if (type === 'play') {
        playBy = actor;
        push(type, data);
      } else if (type === 'rolling') push(type, { ...data, by: playBy }); // countdown ends on its own
      else push(type, data);
    },

    flush,

    sessions() {
      if (cur) flush();
      return read(INDEX, [])
        .slice()
        .reverse();
    },

    // Full export object for one session.
    get(id) {
      if (cur?.id === id) flush();
      const meta = read(INDEX, []).find((s) => s.id === id);
      const data = read(ITEM(id), null);
      if (!meta || !data) return null;
      return {
        app: 'lim-prompter',
        kind: 'take-log',
        format: 1,
        clock: 'unix ms, this phone',
        device: { code, ua: navigator.userAgent },
        session: { id, started: meta.started, ended: meta.ended },
        scripts: data.scripts,
        events: data.events,
      };
    },

    remove(id) {
      if (cur?.id === id) cur = null;
      try {
        localStorage.removeItem(ITEM(id));
        localStorage.setItem(INDEX, JSON.stringify(read(INDEX, []).filter((s) => s.id !== id)));
      } catch {}
    },
  };
}
