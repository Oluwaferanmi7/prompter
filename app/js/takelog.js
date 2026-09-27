// Take log: a timestamped diary of what happened on this teleprompter while a script was
// open, so the editor can line it up with the recording (a scroll back = a retake, a
// mid-shoot script edit = a standing rule, voice position = which line was being read).
//
// Runs on the phone showing the script. Nothing to press: one log per script opening.
// It starts when a script is opened and ends when another script is opened (opening the
// same script again from the list also starts a new one). A reload mid-shoot carries on
// the same log. Logs where nothing happened are dropped. Kept on the phone and exported
// as JSON from Scripts → Take logs, on this phone or from a connected remote.
//
// Export format (format: 2) — times are Unix ms on THIS phone's clock:
//   script:  { id, title }
//   versions: [{ t, text }]                 every version of the script seen in this log
//   events:  [{ t, e, by?, ... }]           by = 'local' or the remote's code
//     open     {v, settings}               script opened (v = version index)
//     play     {countdown}                 play pressed (countdown seconds, 0 = none)
//     rolling  {}                          scrolling actually started (after countdown)
//     pause    {a, w}                      stopped, and where
//     end      {}                          reached the end of the script
//     speed    {v}                         scroll speed changed
//     jump     {kind, from, to, dir, fw, tw}  manual move; kind: para | page | nudge | top | tap | drag
//     pos      {a, w}                      position at the reading line, ~1/s while moving
//     voice    {on}                        voice glide switched on/off
//     heard    {text}                      what voice glide heard (throttled)
//     edit     {v}                         the script was edited (new version v)
//     phone    {code, on, role}            a phone connected / left
//     control  {code}                      control moved to this phone (take over)
//     hidden / visible                     app went to the background / came back
//     close    {}                          another script was opened
//   Positions: a = [paragraph, fraction 0..1], w/fw/tw = word index in the script (approx).
//   Paragraphs are the script's lines (split on "\n"), numbered from 0.
import { NS } from './store.js';

const INDEX = NS + 'tp.logs';
const ITEM = (id) => NS + 'tp.log.' + id;
const RESUME = 20 * 60 * 1000; // a reload within this carries on the same log
const SPLIT = 3 * 60 * 60 * 1000; // same script left open this long: next activity starts a new log
const KEEP = 30; // logs kept on the phone
const PASSIVE = new Set(['open', 'close', 'hidden', 'visible', 'phone', 'control', 'pos']); // not "something happened"

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
  let cur = null; // { id, script: {id,title}, started, last, versions, events, active }
  let actor = 'local';
  let shown = null; // { id, title, text } on screen
  let wordStarts = []; // word index at the start of each paragraph of `shown`
  let flushTimer = 0;
  let editTimer = 0;
  let drag = null; // pending coalesced drag
  let lastHeard = 0;
  let playBy = 'local';
  let settingsSnap = null;

  function setShown(s) {
    shown = { id: s.id, title: s.title, text: s.text };
    wordStarts = [];
    let n = 0;
    for (const line of String(s.text || '').replace(/\r\n?/g, '\n').split('\n')) {
      wordStarts.push(n);
      n += words(line);
    }
    wordStarts.push(n);
  }
  function wordAt(a) {
    if (!a || !wordStarts.length) return 0;
    const p = Math.min(wordStarts.length - 2, Math.max(0, a.p | 0));
    const n = wordStarts[p + 1] - wordStarts[p];
    return wordStarts[p] + Math.round((a.f || 0) * n);
  }
  const A = (a) => (a ? [a.p | 0, round3(a.f)] : [0, 0]);

  function version() {
    const vs = cur.versions;
    if (vs.length && vs[vs.length - 1].text === shown.text) return vs.length - 1;
    vs.push({ t: Date.now(), text: shown.text });
    return vs.length - 1;
  }

  // ------------------------------------------------------------------ opening / closing
  function begin() {
    const now = Date.now();
    cur = {
      id: new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15) + '-' + code + '-' + Math.random().toString(36).slice(2, 5),
      script: { id: shown.id, title: shown.title || 'Untitled' },
      started: now,
      last: now,
      versions: [],
      events: [],
      active: false,
    };
    cur.events.push({ t: now, e: 'open', by: actor, v: version(), settings: settingsSnap?.() || null });
    flush();
  }
  function end() {
    if (!cur) return;
    flushDrag();
    if (!cur.active) {
      remove(cur.id); // opened and left without anything happening
      cur = null;
      return;
    }
    cur.events.push({ t: Date.now(), e: 'close', by: actor });
    cur.closed = true;
    flush();
    cur = null;
  }

  function push(type, data = {}) {
    if (!shown) return;
    const now = Date.now();
    if (!cur) begin();
    else if (!PASSIVE.has(type) && now - cur.last > SPLIT) {
      // Same script left open for hours: treat this as a new sitting.
      end();
      begin();
    }
    const who = !['hidden', 'visible', 'phone', 'control', 'pos', 'heard'].includes(type) ? { by: actor } : {};
    const ev = { t: now, e: type, ...who, ...data };
    cur.events.push(ev);
    cur.last = now;
    if (!PASSIVE.has(type)) cur.active = true;
    scheduleFlush();
  }

  function flushDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    clearTimeout(d.timer);
    if (d.fw === d.tw && d.from[0] === d.to[0] && Math.abs(d.from[1] - d.to[1]) < 0.02) return; // no real move
    push('jump', { kind: 'drag', from: d.from, to: d.to, dir: d.tw < d.fw ? 'back' : 'fwd', fw: d.fw, tw: d.tw, by: d.by });
  }

  // ------------------------------------------------------------------ storage
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 5000);
  }
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (!cur) return;
    const data = JSON.stringify({ script: cur.script, versions: cur.versions, events: cur.events, active: cur.active });
    for (let tries = 0; tries < KEEP; tries++) {
      try {
        localStorage.setItem(ITEM(cur.id), data);
        break;
      } catch {
        if (!dropOldest()) break; // storage full: make room and retry
      }
    }
    let list = read(INDEX, []).filter((s) => s.id !== cur.id);
    list.push({ id: cur.id, scriptId: cur.script.id, title: cur.script.title, started: cur.started, ended: cur.last, count: cur.events.length, active: cur.active, closed: !!cur.closed });
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
    remove(old.id);
    return true;
  }
  function remove(id) {
    try {
      localStorage.removeItem(ITEM(id));
      localStorage.setItem(INDEX, JSON.stringify(read(INDEX, []).filter((s) => s.id !== id)));
    } catch {}
  }

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
    // Function returning the current display settings (snapshotted when a log opens).
    set settings(fn) {
      settingsSnap = fn;
    },

    // A script was opened on purpose (picked from the list, locally or by a remote):
    // close the current log and start a new one.
    open(s) {
      end();
      setShown(s);
      begin();
    },

    // The app started showing its last script: carry on that script's log after a reload,
    // otherwise start a new one.
    resume(s) {
      setShown(s);
      const last = read(INDEX, []).slice(-1)[0];
      const data = last && !last.closed && last.scriptId === s.id && Date.now() - last.ended < RESUME ? read(ITEM(last.id), null) : null;
      if (data) cur = { id: last.id, script: data.script, started: last.started, last: last.ended, versions: data.versions || [], events: data.events || [], active: !!data.active };
      else begin();
    },

    // The open script's text changed (typed here or on a remote).
    edited(s) {
      if (!shown || s.id !== shown.id) return;
      setShown(s);
      if (cur) cur.script.title = s.title || cur.script.title;
      // Typing fires many updates; record the text once it settles.
      const by = actor;
      clearTimeout(editTimer);
      editTimer = setTimeout(() => {
        if (!cur || shown.id !== s.id) return;
        const n = cur.versions.length;
        const v = version();
        if (v === n) {
          const prev = actor;
          actor = by;
          push('edit', { v });
          actor = prev;
        }
      }, 2500);
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

    // Logs with something in them, newest first.
    sessions() {
      if (cur) flush();
      return read(INDEX, [])
        .filter((s) => s.active)
        .reverse();
    },

    // Full export object for one log.
    get(id) {
      if (cur?.id === id) flush();
      const meta = read(INDEX, []).find((s) => s.id === id);
      const data = read(ITEM(id), null);
      if (!meta || !data) return null;
      return {
        app: 'lim-prompter',
        kind: 'take-log',
        format: 2,
        clock: 'unix ms, this phone',
        device: { code, ua: navigator.userAgent },
        log: { id, started: meta.started, ended: meta.ended, open: cur?.id === id },
        script: data.script,
        versions: data.versions,
        events: data.events,
      };
    },
  };
}
