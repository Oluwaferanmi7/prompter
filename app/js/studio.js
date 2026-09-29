// Studio: the Hub's second step. Only the cameras and mics picked in Setup, the
// teleprompter as a viewer panel, and Record. Each camera and each mic records to its own
// file, written to disk every second (crash-safe), into one folder per take, with a
// take.json describing it. The teleprompter's take log gets the record start/stop too, so
// the editor can line everything up.
//
// After Stop the desktop app (0.3.0+) makes the files usable everywhere: MP4s rebuilt so they
// can be scrubbed, mic WebMs turned into 32-bit float WAVs (+ MP3 if switched on). Nothing is
// re-encoded; the recorder's own files are kept in the take's Originals folder.
//
// The side panel has three modes: Teleprompter (this computer shows the script, e.g. to
// read while recording on a webcam; phones can still connect to it as remotes), Remote
// (this computer drives the teleprompter phone) and Viewer (follow only).
//
// This first version records with the app's own engine (MediaRecorder) so recording and
// the live previews share the same device handles. Phones show as previews; recording
// them (full quality on the phone, sent over after Stop) is the next step.
import * as lib from './library.js';
import * as store from './store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' : ''}${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
const pick = (types) => types.find((t) => window.MediaRecorder?.isTypeSupported?.(t));
const VIDEO = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm'];
const AUDIO = ['audio/webm;codecs=pcm', 'audio/webm;codecs=opus', 'audio/webm']; // PCM = lossless

export function createStudio({ root, link, hub, remote, prompter, log, toast, audioCtx }) {
  root.innerHTML = `
    <div class="st-main">
      <div class="st-cams" data-st="cams"></div>
      <div class="st-mics" data-st="mics"></div>
    </div>
    <aside class="st-side">
      <div class="st-side-head"><span>Teleprompter</span><button class="pill" data-st="tpcode"><span class="dot"></span><span data-st="tpstatus">Not connected</span></button></div>
      <div class="seg st-modes" data-st="modes">
        <button data-mode="teleprompter" title="This computer shows the script">Teleprompter</button>
        <button data-mode="remote" title="Control the teleprompter phone from here">Remote</button>
        <button data-mode="viewer" title="Follow the teleprompter phone">Viewer</button>
      </div>
      <select class="st-pick" data-st="pick" aria-label="Script" hidden></select>
      <div class="st-tp" data-st="tp"></div>
      <div class="st-ask" data-st="ask" hidden>
        <p class="muted small">Enter the teleprompter phone's code to follow the script here.</p>
        <input class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD">
      </div>
      <div class="st-ctl" data-st="ctl">
        <button class="btn ghost small" data-c="top" title="Back to the start (Home)">⤒</button>
        <button class="btn ghost small" data-c="back" title="Previous paragraph (Page Up)">‹</button>
        <button class="btn primary small st-play" data-c="play" title="Play / pause (Space)">▶</button>
        <button class="btn ghost small" data-c="fwd" title="Next paragraph (Page Down)">›</button>
        <span class="st-speed"><button class="btn ghost small" data-c="slower" title="Slower (−)">−</button><span data-st="speed">6</span><button class="btn ghost small" data-c="faster" title="Faster (+)">+</button></span>
        <span class="st-size" data-st="size"><button class="btn ghost small" data-c="smaller" title="Smaller text">A−</button><button class="btn ghost small" data-c="bigger" title="Bigger text">A+</button></span>
        <button class="btn ghost small" data-c="takeover" data-st="takeover" hidden>Take over</button>
      </div>
    </aside>
    <div class="st-bar">
      <div class="st-left"><button class="btn ghost small" data-st="folder">Save to…</button><button class="btn ghost small" data-st="mp3" hidden>+ MP3: Off</button><span class="muted small st-root" data-st="root"></span></div>
      <div class="st-center"><button class="cam-rec" data-st="rec" aria-label="Record"><span></span></button><span class="st-time" data-st="time" hidden>00:00</span></div>
      <div class="st-right muted small" data-st="saved"></div>
    </div>`;
  const $ = (k) => root.querySelector(`[data-st=${k}]`);
  const deskApi = () => window.sapphireDesktop?.rec; // the desktop app's file writer
  let sel = null; // { cams: [{ name, label, stream, phone }], mics: [{ name, label, stream }] }
  let take = null;
  let clock = 0;
  let raf = 0;
  const meters = [];
  let active = false;
  const MODES = ['teleprompter', 'remote', 'viewer'];
  let mode = MODES.includes(store.getPrefs().studioMode) ? store.getPrefs().studioMode : 'viewer';
  let syncTimer = 0;
  let canFinish = false; // desktop app can make the files playable after Stop
  let finishing = null; // the take being made playable
  const mp3On = () => !!store.getPrefs().recMp3;
  const showMp3 = () => {
    $('mp3').hidden = !canFinish;
    $('mp3').textContent = `+ MP3: ${mp3On() ? 'On' : 'Off'}`;
    $('mp3').title = 'Also save an MP3 of each mic, next to the WAV';
  };
  deskApi()?.onProgress?.((p) => {
    if (finishing?.token !== p.token) return;
    $('saved').textContent = `Making files playable… ${p.index + 1}/${p.count} · ${p.pct}%`;
  });

  // ------------------------------------------------------------------ layout
  function build() {
    const cams = $('cams');
    cams.replaceChildren();
    cams.dataset.n = Math.min(sel.cams.length, 4);
    for (const c of sel.cams) {
      const t = document.createElement('div');
      t.className = 'st-cam';
      t.innerHTML = `<video muted playsinline autoplay></video><span class="st-label">${esc(c.name)}${c.phone ? ' · phone (preview only for now)' : ''}</span>`;
      t.querySelector('video').srcObject = c.stream;
      cams.appendChild(t);
    }
    if (!sel.cams.length) cams.innerHTML = '<p class="muted">No cameras picked. Go back to Setup and tick at least one.</p>';
    const mics = $('mics');
    mics.replaceChildren();
    meters.length = 0;
    for (const m of sel.mics) {
      const r = document.createElement('div');
      r.className = 'st-mic';
      r.innerHTML = `<span>${esc(m.name)}</span><div class="hub-meter"><span></span></div>`;
      mics.appendChild(r);
      if (audioCtx() && m.stream) {
        const an = audioCtx().createAnalyser();
        an.fftSize = 1024;
        audioCtx().createMediaStreamSource(m.stream).connect(an);
        meters.push({ an, bar: r.querySelector('.hub-meter span'), buf: new Float32Array(an.fftSize), level: 0 });
      }
    }
    const draw = () => {
      raf = requestAnimationFrame(draw);
      for (const m of meters) {
        m.an.getFloatTimeDomainData(m.buf);
        let peak = 0;
        for (const v of m.buf) peak = Math.max(peak, Math.abs(v));
        m.level = Math.max(peak, m.level * 0.9);
        const db = 20 * Math.log10(m.level || 1e-6);
        m.bar.style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
        m.bar.classList.toggle('hot', db > -3);
      }
    };
    cancelAnimationFrame(raf);
    draw();
    deskApi()?.root().then((r) => ($('root').textContent = r));
    Promise.resolve(deskApi()?.canFinish?.())
      .catch(() => false)
      .then((ok) => {
        canFinish = !!ok;
        showMp3();
      });
    if (!deskApi()) $('root').textContent = 'Recording works in the Sapphire desktop app.';
  }

  // ------------------------------------------------------------------ teleprompter panel
  const own = () => mode === 'teleprompter';
  const ctl = () => (own() ? prompter.ctl : remote.ctl);

  function setMode(m) {
    mode = m;
    const p = store.getPrefs();
    p.studioMode = m;
    store.savePrefs(p);
    for (const b of root.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === m);
    if (own()) {
      // This computer is the teleprompter now; phones connect to it (its code is in the pill).
      remote.detach();
      if (link.targetCode) link.disconnect();
      prompter.attach($('tp'));
      fillPicker();
    } else {
      prompter.detach();
      if (hub.role !== m) hub.setRole(m);
      remote.attach($('tp'));
      const code = store.getRemoteCode();
      if (code && !link.targetCode) link.connect(code);
    }
    $('pick').hidden = !own();
    $('size').hidden = !own();
    $('ctl').hidden = m === 'viewer';
    sync();
  }

  function fillPicker() {
    const pick = $('pick');
    const cur = prompter.engine.script?.id;
    pick.replaceChildren(
      ...lib.all().map((sc) => {
        const o = document.createElement('option');
        o.value = sc.id;
        o.textContent = sc.title || 'Untitled';
        o.selected = sc.id === cur;
        return o;
      })
    );
  }
  $('pick').addEventListener('mousedown', fillPicker); // the list stays current as scripts change
  $('pick').addEventListener('change', (e) => prompter.ctl.select(e.target.value));

  function tpStatus() {
    if (!active) return;
    const pill = $('tpcode');
    if (own()) {
      const n = link.controllerCount;
      pill.className = 'pill ' + (n ? 'ok' : '');
      $('tpstatus').textContent = `This computer · ${link.code}${n ? ` · ${n} connected` : ''}`;
      pill.title = `Phones can control this teleprompter: Connect → enter ${link.code}`;
      $('ask').hidden = true;
      return;
    }
    const t = link.targetStatus;
    const code = link.targetCode;
    pill.className = 'pill ' + (t === 'connected' ? 'ok' : t === 'idle' ? '' : t === 'notfound' ? 'bad' : 'wait');
    pill.title = '';
    $('tpstatus').textContent = !code || hub.role === 'camera' ? 'Not connected' : t === 'connected' ? `${mode === 'remote' ? 'Controlling' : 'Following'} ${code}` : t === 'notfound' ? `${code} not found` : `Connecting ${code}…`;
    $('ask').hidden = !(!code || hub.role === 'camera');
  }
  // Play button, speed and "someone else is in control", kept current.
  function sync() {
    if (!active) return;
    const c = ctl();
    const st = c.state || {};
    const playing = own() ? prompter.engine.playing : !!(st.playing || st.counting);
    $('ctl').querySelector('[data-c=play]').textContent = playing ? '❚❚' : '▶';
    $('speed').textContent = String(c.settings?.speed ?? '–');
    const locked = mode === 'remote' && link.connected && !!remote.ctl.blocked();
    $('takeover').hidden = !locked;
    $('ctl').classList.toggle('locked', locked);
    tpStatus();
  }

  const input = root.querySelector('.st-ask input');
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (input.value.length < 4 || !/^[A-HJ-KM-NP-Z2-9]{4}$/.test(input.value) || input.value === link.code) return;
    hub.setRole(mode === 'remote' ? 'remote' : 'viewer');
    store.setRemoteCode(input.value);
    link.connect(input.value);
    input.value = '';
    tpStatus();
  });

  function control(k) {
    const c = ctl();
    if (k === 'takeover') return hub.takeover();
    if (!own()) {
      if (!link.connected) return toast('Not connected to the teleprompter.');
      if (remote.ctl.blocked()) return toast(`${remote.rosterInfo?.seat || 'Another phone'} is in control. Tap Take over.`);
    }
    if (k === 'play') c.toggle();
    else if (k === 'top') c.top();
    else if (k === 'back') c.para(-1);
    else if (k === 'fwd') c.para(1);
    else if (k === 'slower' || k === 'faster') c.setSpeed((c.settings?.speed || 6) + (k === 'faster' ? 0.5 : -0.5));
    else if (k === 'smaller' || k === 'bigger') {
      const fs = prompter.engine.settings.fontSize;
      c.setSetting('fontSize', Math.round(Math.max(16, Math.min(160, fs * (k === 'bigger' ? 1.1 : 1 / 1.1)))));
    }
    sync();
  }

  // ------------------------------------------------------------------ recording
  // Record/Stop marks go to one take log for the whole take, even if the mode changes.
  function mark(t, on) {
    if (t.mine) log.event('rec', { on, take: t.name, hub: 'this computer' });
    else link.send({ t: 'rec', on, take: t.name });
  }

  async function start() {
    if (!deskApi()) return toast('Recording works in the Sapphire desktop app.');
    const cams = sel.cams.filter((c) => !c.phone && c.stream);
    const mics = sel.mics.filter((m) => m.stream);
    if (!cams.length && !mics.length) return toast('Nothing to record: pick a camera or mic in Setup.');
    const vmime = pick(VIDEO);
    const amime = pick(AUDIO);
    const now = new Date();
    const mine = own(); // whose take log gets the marks: this computer's, or the phone's
    const script = mine ? prompter.engine.script : lib.get(remote.state?.scriptId);
    const name = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())} ${script?.title || 'Take'}`;
    const { token, folder } = await deskApi().begin(name);
    take = { token, folder, name, script, mine, started: 0, recs: [] };
    const vext = /mp4/.test(vmime) ? 'mp4' : 'webm';
    // Open every file first, then start every recorder together.
    // "Camera 1.mp4", or "Camera 1 - Wide.mp4" once it has a name.
    const label = (kind, i, name) => (name === `${kind} ${i}` ? name : `${kind} ${i} - ${name}`);
    cams.forEach((c, i) => take.recs.push({ kind: 'video', mime: vmime, file: `${label('Camera', i + 1, c.name)}.${vext}`, name: c.name, device: c.label, stream: new MediaStream(c.stream.getVideoTracks()) }));
    mics.forEach((m, i) => take.recs.push({ kind: 'audio', mime: amime, file: `${label('Mic', i + 1, m.name)}.webm`, name: m.name, device: m.label, stream: new MediaStream(m.stream.getAudioTracks()) }));
    for (const r of take.recs) {
      r.fid = await deskApi().open(token, r.file);
      r.chain = Promise.resolve();
      r.mr = new MediaRecorder(r.stream, r.kind === 'video' ? { mimeType: r.mime, videoBitsPerSecond: 16_000_000 } : { mimeType: r.mime });
      r.mr.onstart = () => (r.startedAt = Date.now());
      r.mr.ondataavailable = (e) => {
        if (!e.data?.size) return;
        r.chain = r.chain.then(async () => deskApi().write(r.fid, await e.data.arrayBuffer())).catch((err) => (r.error = String(err?.message || err)));
      };
      r.stopped = new Promise((ok) => (r.mr.onstop = ok));
    }
    take.started = Date.now();
    for (const r of take.recs) r.mr.start(1000);
    mark(take, true); // into the teleprompter's take log
    clock = setInterval(tick, 250);
    tick();
    $('saved').textContent = '';
  }

  async function stop() {
    if (!take) return;
    const t = take;
    take = null;
    clearInterval(clock);
    const ended = Date.now();
    mark(t, false);
    tick();
    $('saved').textContent = 'Finishing…';
    for (const r of t.recs) if (r.mr.state !== 'inactive') r.mr.stop();
    const files = [];
    for (const r of t.recs) {
      await r.stopped;
      await r.chain;
      const bytes = await deskApi().close(r.fid).catch(() => null);
      files.push({ file: r.file, kind: r.kind, name: r.name, device: r.device, mime: r.mime, startedAt: r.startedAt, offsetMs: r.startedAt - t.started, bytes, error: r.error || undefined });
    }
    const manifest = {
      app: 'sapphire',
      kind: 'take',
      format: 1,
      clock: 'unix ms, hub computer',
      take: t.name,
      started: t.started,
      ended,
      teleprompter: { code: t.mine ? link.code : link.targetCode || null, where: t.mine ? 'this computer' : 'phone', scriptId: t.script?.id || null, title: t.script?.title || null },
      files,
    };
    const writeManifest = () => deskApi().writeText(t.token, 'take.json', JSON.stringify(manifest, null, 2));
    await writeManifest(); // written before finishing too, so a crash there still leaves a described take
    if (canFinish) {
      finishing = t;
      $('saved').textContent = 'Making files playable…';
      const todo = files.filter((f) => !f.error && f.bytes);
      const results = await deskApi()
        .finish(t.token, todo.map((f) => ({ file: f.file, kind: f.kind })), { mp3: mp3On(), durationMs: ended - t.started })
        .catch((err) => todo.map((f) => ({ ok: false, from: f.file, error: String(err?.message || err) })));
      finishing = null;
      for (const r of results) {
        const f = files.find((x) => x.file === r.from);
        if (!f) continue;
        if (r.ok) Object.assign(f, { file: r.file, original: r.original, mp3: r.mp3, bytes: r.bytes, md5: r.md5 });
        else f.finishError = r.error; // the recorder's file is still there, under its own name
      }
      await writeManifest();
    }
    const bad = files.filter((f) => f.error);
    const unfinished = files.filter((f) => f.finishError);
    const saved = $('saved');
    saved.innerHTML = `${bad.length ? `<b class="bad-text">${bad.length} file(s) had a problem.</b> ` : ''}${unfinished.length ? `<b class="bad-text">${unfinished.length} file(s) couldn't be made playable (originals kept).</b> ` : ''}Saved ${files.length} file${files.length === 1 ? '' : 's'} · ${fmt(ended - t.started)} <button class="btn ghost small" data-st="open">Open folder</button>`;
    saved.querySelector('[data-st=open]').onclick = () => deskApi().reveal(t.token);
    toast(bad.length || unfinished.length ? 'Take saved, with problems. Check the folder.' : 'Take saved.');
  }

  function tick() {
    const on = !!take;
    $('rec').classList.toggle('on', on);
    $('rec').setAttribute('aria-label', on ? 'Stop' : 'Record');
    $('time').hidden = !on;
    root.classList.toggle('recording', on);
    if (on) $('time').textContent = fmt(Date.now() - take.started);
  }

  root.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-mode]')?.dataset.mode;
    if (m) return m !== mode && setMode(m);
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (c) return control(c);
    const k = e.target.closest('[data-st]')?.dataset.st;
    if (k === 'rec') take ? stop() : start();
    else if (k === 'folder' && deskApi() && !take) $('root').textContent = await deskApi().chooseRoot();
    else if (k === 'tpcode' && !own()) $('ask').hidden = !$('ask').hidden;
    else if (k === 'mp3') {
      store.savePrefs({ ...store.getPrefs(), recMp3: !mp3On() });
      showMp3();
    }
  });

  return {
    get recording() {
      return !!take;
    },
    enter(selection) {
      sel = selection;
      active = true;
      root.hidden = false;
      build();
      setMode(mode);
      clearInterval(syncTimer);
      syncTimer = setInterval(sync, 300);
    },
    leave() {
      if (take) stop();
      active = false;
      root.hidden = true;
      cancelAnimationFrame(raf);
      meters.length = 0;
      clearInterval(syncTimer);
      prompter.detach();
      remote.detach();
    },
    get ownPrompter() {
      return active && own();
    },
    linkStatus: tpStatus,
  };
}
