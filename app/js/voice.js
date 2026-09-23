// Voice glide: listens with the phone's speech recognition and moves the script so the
// next words you should say sit at the reading line. Tolerates added, swapped or
// skipped words; when you go off script it simply holds until you come back.
//
// Matching: the script is a list of normalized words, each mapped to a position
// (paragraph + fraction). For every recognition update we take the last few words
// heard and look for the best alignment inside a window around the current cursor,
// allowing spoken words to be skipped (ad-libs) and script words to be skipped
// (dropped words). We only move when enough words line up.

const W = typeof window !== 'undefined' ? window : {};
const SR = W.SpeechRecognition || W.webkitSpeechRecognition;
export const supported = !!SR;

const norm = (w) =>
  w
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '');

const NUMBERS = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
const canon = (w) => NUMBERS[w] || w;

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function same(a, b) {
  if (a === b) return true;
  const L = Math.max(a.length, b.length);
  if (L < 3) return false;
  if (L >= 5 && (a.startsWith(b) || b.startsWith(a)) && Math.min(a.length, b.length) >= 4) return true; // walk/walking
  return lev(a, b) <= (L >= 8 ? 2 : L >= 4 ? 1 : 0);
}

// Build the word index from the script text.
export function indexScript(text) {
  const words = [];
  const paras = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  paras.forEach((line, p) => {
    const raw = line.match(/\S+/g) || [];
    const clean = raw.map(norm).map(canon).filter(Boolean);
    clean.forEach((w, i) => words.push({ w, p, f: (i + 0.5) / clean.length }));
  });
  return words;
}

// Best alignment of `spoken` (array of normalized words, newest last) inside
// script[lo..hi]. Returns { end, score } where end = script index of the last matched
// word, or null.
function align(script, spoken, lo, hi, expect) {
  let best = null;
  for (let j = Math.max(0, lo); j <= Math.min(script.length - 1, hi); j++) {
    let k = j;
    let count = 0;
    let skipped = 0;
    let trail = -1; // spoken words after the last match (a short ad-lib at the end)
    let end = -1; // script index of the last word actually matched
    for (let i = spoken.length - 1; i >= 0 && k >= 0; i--) {
      // look for spoken[i] at k, k-1 or k-2 (script words the speaker dropped)
      let hit = -1;
      for (let d = 0; d <= 2 && k - d >= 0; d++) {
        if (same(spoken[i], script[k - d].w)) {
          hit = k - d;
          break;
        }
      }
      if (hit >= 0) {
        if (trail < 0) {
          trail = skipped;
          end = hit;
        }
        count++;
        k = hit - 1;
      } else skipped++;
    }
    if (!count) continue;
    const score = count - trail * 0.3 - Math.abs(end - expect) * 0.03;
    if (!best || score > best.score) best = { end, count, trail, score };
  }
  return best;
}

export function createVoice({ onMove, onStatus, onHeard }) {
  let rec = null;
  let on = false;
  let script = [];
  let cursor = -1; // last matched script word index
  let finals = []; // committed words from finished utterances
  let restartTimer = 0;
  let lastMoveAt = 0;

  function setScript(text) {
    script = indexScript(text);
    cursor = -1;
    finals = [];
  }

  const events = []; // short diagnostics log (shown under Connect → Voice diagnostics)
  function log(msg) {
    const t = new Date();
    events.push(`${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')} ${msg}`);
    if (events.length > 40) events.shift();
  }
  function status(s, detail) {
    log(`status: ${s}${detail ? ' — ' + detail : ''}`);
    onStatus?.(s, detail);
  }
  let resumeWatch = 0;

  function handleWords(words, isFinal) {
    if (!script.length || !words.length) return;
    const spoken = words.slice(-7);
    const expect = cursor + 3; // reading normally lands a few words past the cursor
    // Near window first (normal reading, small retakes); wide window as a fallback for
    // skipping ahead, which needs stronger evidence.
    let hit = align(script, spoken, cursor - 12, cursor + 30, expect);
    const need = Math.min(3, spoken.length);
    const ok = (h, maxTrail) => h && h.count >= need && h.trail <= maxTrail;
    if (!ok(hit, 3)) {
      // Truly lost nearby? Only then consider a jump elsewhere, and only on a long,
      // clean run of matches — common words ("to the", "and it") must not move us.
      const lostNearby = !hit || hit.count < 2;
      const wide = lostNearby && spoken.length >= 6 ? align(script, spoken, 0, script.length - 1, expect) : null;
      if (wide && wide.count >= 6 && wide.trail === 0) hit = wide;
      else if (!ok(hit, 3)) return; // off script: hold where we are
    }
    // A big hop within the near window also needs more than a couple of hits.
    if (Math.abs(hit.end - cursor) > 10 && hit.count < 4) return;
    log(`move → ${hit.end} (${hit.count} hits)`);
    cursor = hit.end;
    lastMoveAt = performance.now();
    // Put the *next* word at the reading line (the eye reads slightly ahead).
    const next = script[Math.min(script.length - 1, cursor + 1)];
    onMove?.({ p: next.p, f: next.f }, isFinal);
  }

  function start() {
    if (!on || !SR) return;
    clearTimeout(restartTimer);
    try {
      rec?.abort?.();
    } catch {}
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = navigator.language?.startsWith('en') ? navigator.language : 'en-US';
    rec.onstart = () => {
      clearTimeout(resumeWatch);
      status('listening');
    };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0]?.transcript || '';
        if (r.isFinal) finals.push(...t.split(/\s+/).map(norm).map(canon).filter(Boolean));
        else interim += ' ' + t;
      }
      if (finals.length > 40) finals = finals.slice(-40);
      const cur = interim.split(/\s+/).map(norm).map(canon).filter(Boolean);
      const words = finals.concat(cur);
      onHeard?.(words.slice(-8).join(' '));
      handleWords(words, !cur.length);
    };
    rec.onerror = (e) => {
      const t = e?.error;
      log(`error: ${t}`);
      if (t === 'not-allowed' || t === 'service-not-allowed') {
        on = false;
        status(
          'blocked',
          t === 'not-allowed'
            ? resumed
              ? 'Voice glide paused — tap the mic to resume'
              : 'Microphone access was denied'
            : 'Speech recognition is blocked on this phone (needs a recent iOS with Dictation on)'
        );
        return;
      }
      if (t === 'aborted') return;
      // no-speech / network / audio-capture: restart quietly
      status('waiting');
    };
    rec.onend = () => {
      log('end');
      if (!on) return status('off');
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return; // resume on return
      restartTimer = setTimeout(start, 300);
    };
    try {
      rec.start();
      status('starting');
    } catch {
      restartTimer = setTimeout(start, 800);
    }
  }

  function stop() {
    on = false;
    clearTimeout(restartTimer);
    clearTimeout(resumeWatch);
    try {
      rec?.stop?.();
    } catch {}
    rec = null;
    status('off');
  }

  // iOS kills the recognizer when the app goes to the background; if we keep trying
  // to restart it there it wedges for minutes. So: release it cleanly on hide, try
  // once on return, and hand back to the mic button if iOS refuses (it needs a tap).
  let resumed = false;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!on) return;
      if (document.visibilityState === 'hidden') {
        clearTimeout(restartTimer);
        const r = rec;
        rec = null;
        try {
          r?.abort?.();
        } catch {}
        status('paused');
      } else {
        resumed = true;
        start();
        clearTimeout(resumeWatch);
        resumeWatch = setTimeout(() => {
          if (on && rec) {
            log('resume timed out');
            on = false;
            try {
              rec.abort?.();
            } catch {}
            rec = null;
            status('blocked', 'Voice glide paused — tap the mic to resume');
          }
        }, 3000);
      }
    });
  }

  return {
    get on() {
      return on;
    },
    supported,
    setScript,
    // Tell the matcher where the reader is (after a manual jump) so it searches nearby.
    setCursorNear(anchor) {
      if (!script.length) return;
      let best = 0;
      let bestD = Infinity;
      script.forEach((w, i) => {
        const d = Math.abs(w.p - anchor.p) * 1000 + Math.abs(w.f - anchor.f);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      cursor = best - 1;
      finals = [];
    },
    enable() {
      if (!SR) {
        status('unsupported', 'Voice needs Safari or Chrome');
        return false;
      }
      on = true;
      resumed = false;
      finals = [];
      log('enable (tap)');
      start();
      return true;
    },
    get log() {
      return events.slice();
    },
    disable: stop,
    get idleFor() {
      return performance.now() - lastMoveAt;
    },
    // Test hook: feed words as if recognized (newest last).
    feed(words, isFinal = true) {
      const w = words.map(norm).map(canon).filter(Boolean);
      if (isFinal) finals = finals.concat(w).slice(-40);
      handleWords(isFinal ? finals : finals.concat(w), isFinal);
    },
    get cursor() {
      return cursor;
    },
  };
}
