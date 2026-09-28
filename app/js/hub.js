// Hub (desktop app only): the computer the cameras and mics plug into, and that phones join
// as cameras. It shows every camera and microphone this computer can see (capture cards
// appear as cameras) with live previews and level meters, plus phones joined as cameras
// ("Camera for the Hub" on the phone), and lets you pick and name what this shoot uses.
// Recording comes next.
import * as store from './store.js';
import { createStudio } from './studio.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Only in the desktop app (its preload sets window.sapphireDesktop), or ?hub on localhost for testing.
export const hubAvailable = () => !!window.sapphireDesktop || (['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('hub'));

// Studio computers are full of virtual devices (NDI, vMix, OBS, Voicemeeter…). They go in
// their own folded sections, off by default. Opening a virtual camera with nothing feeding
// it can hang, so every device gets a time limit and only ticked devices are opened.
const VIRTUAL = /\b(NDI|vMix|OBS|Virtual|Voicemeeter|VB-Audio|VAIO|Snap Camera|ManyCam|XSplit|Streamlabs|Camo|Iriun|DroidCam)\b/i;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('timeout'), { name: 'Timeout' })), ms))]);

const SECTIONS = [
  ['cams', 'Cameras', true],
  ['phones', 'Phone cameras', true],
  ['vcams', 'Virtual cameras (NDI, vMix, OBS…)', false],
  ['mics', 'Microphones', true],
  ['vmics', 'Virtual inputs (Voicemeeter, NDI…)', false],
];

export function createHub({ link, hub, remote, toast, onHome }) {
  const view = $('hub');
  view.innerHTML = `
    <header class="hub-top">
      <button class="back-btn" data-h="back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg><span data-h-back>Home</span></button>
      <div class="hub-title" data-h-title>Hub · Setup</div>
      <button class="btn ghost small" data-h="refresh">Refresh</button>
    </header>
    <div class="hub-body">
      <p class="muted hub-lede">Everything plugged into this computer, plus phones joined as cameras. Tick what this shoot uses and give it a name.</p>
      ${SECTIONS.map(([key, title]) => `<details class="hub-sec" data-sec="${key}"><summary><span>${title}</span><small class="muted" data-count></small></summary><div class="${key.endsWith('mics') ? 'hub-mics' : 'hub-grid'}" data-list></div></details>`).join('')}
    </div>
    <div class="hub-next"><span class="muted small" data-h-sum></span><button class="btn primary" data-h="next">Next: Studio ›</button></div>
    <div class="hub-studio" hidden></div>`;
  const sec = (key) => view.querySelector(`[data-sec=${key}]`);
  const list = (key) => sec(key).querySelector('[data-list]');
  const count = (key, n, extra = '') => (sec(key).querySelector('[data-count]').textContent = `${n}${extra}`);

  // Folded / unfolded is remembered per section.
  const openPrefs = () => store.getPrefs().hubOpen || {};
  for (const [key, , def] of SECTIONS) {
    const d = sec(key);
    d.open = openPrefs()[key] ?? def;
    d.addEventListener('toggle', () => {
      const p = store.getPrefs();
      p.hubOpen = { ...(p.hubOpen || {}), [key]: d.open };
      store.savePrefs(p);
    });
  }

  let active = false;
  let mode = 'setup'; // setup | studio
  let audioCtx = null;
  let camDevs = [];
  let micDevs = [];
  let raf = 0;
  const meters = [];
  const open = new Map(); // deviceId -> MediaStream (this computer's devices)

  const prefs = () => store.getPrefs().hub || { cams: {}, mics: {} };
  function savePick(kind, id, patch) {
    const p = store.getPrefs();
    const h = p.hub || { cams: {}, mics: {} };
    h[kind] = h[kind] || {};
    h[kind][id] = { ...(h[kind][id] || {}), ...patch };
    p.hub = h;
    store.savePrefs(p);
  }

  function stopDevice(id) {
    open.get(id)?.getTracks().forEach((t) => t.stop());
    open.delete(id);
    const i = meters.findIndex((m) => m.id === id);
    if (i >= 0) meters.splice(i, 1);
  }
  function closeAll() {
    cancelAnimationFrame(raf);
    open.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    open.clear();
    meters.length = 0;
    audioCtx?.close().catch(() => {});
    audioCtx = null;
  }

  // ------------------------------------------------------------------ this computer's devices
  async function startCam(d, tile) {
    const res = tile.querySelector('.hub-res');
    res.textContent = 'Opening…';
    tile.classList.remove('bad');
    try {
      const s = await withTimeout(
        navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: d.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } }),
        10000
      );
      if (!active || !tile.querySelector('input[type=checkbox]').checked) return s.getTracks().forEach((t) => t.stop());
      open.set(d.deviceId, s);
      tile.querySelector('video').srcObject = s;
      const st = s.getVideoTracks()[0].getSettings();
      res.textContent = `${st.width}×${st.height} · ${Math.round(st.frameRate || 0)} fps`;
    } catch (err) {
      res.textContent = err?.name === 'Timeout' ? 'No signal' : err?.name === 'NotReadableError' ? 'In use by another app' : "Can't open";
      tile.classList.add('bad');
    }
  }
  async function startMic(d, row) {
    try {
      const s = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: d.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }), 10000);
      if (!active || !audioCtx || !row.querySelector('input[type=checkbox]').checked) return s.getTracks().forEach((t) => t.stop());
      open.set(d.deviceId, s);
      const an = audioCtx.createAnalyser();
      an.fftSize = 1024;
      audioCtx.createMediaStreamSource(s).connect(an);
      meters.push({ id: d.deviceId, an, bar: row.querySelector('.hub-meter span'), buf: new Float32Array(an.fftSize), level: 0 });
      row.classList.remove('bad');
    } catch {
      row.classList.add('bad');
    }
  }

  function camTile(d, i, P, virtual) {
    const pick = P.cams[d.deviceId] || {};
    const on = pick.use ?? !virtual;
    const tile = document.createElement('div');
    tile.className = 'hub-cam' + (on ? '' : ' off');
    tile.innerHTML = `<div class="hub-video"><video muted playsinline autoplay></video><span class="hub-res">${on ? '' : 'Off'}</span></div>
      <div class="hub-row"><input class="hub-name" maxlength="30" placeholder="Camera ${i + 1}"><label class="hub-use"><input type="checkbox"> Use</label></div>
      <div class="muted small hub-dev">${esc(d.label || 'Camera ' + (i + 1))}</div>`;
    const name = tile.querySelector('.hub-name');
    const use = tile.querySelector('input[type=checkbox]');
    name.value = pick.name || '';
    use.checked = on;
    name.onchange = () => savePick('cams', d.deviceId, { name: name.value.trim(), label: d.label });
    use.onchange = () => {
      savePick('cams', d.deviceId, { use: use.checked, label: d.label });
      tile.classList.toggle('off', !use.checked);
      if (use.checked) startCam(d, tile);
      else {
        stopDevice(d.deviceId);
        tile.querySelector('video').srcObject = null;
        tile.querySelector('.hub-res').textContent = 'Off';
        tile.classList.remove('bad');
      }
    };
    if (on) startCam(d, tile);
    return tile;
  }
  function micRow(d, i, P, virtual) {
    const pick = P.mics[d.deviceId] || {};
    const on = pick.use ?? !virtual;
    const row = document.createElement('div');
    row.className = 'hub-mic' + (on ? '' : ' off');
    row.innerHTML = `<label class="hub-use"><input type="checkbox"></label>
      <div class="hub-mic-txt"><input class="hub-name" maxlength="30" placeholder="Mic ${i + 1}"><div class="muted small">${esc(d.label || 'Microphone ' + (i + 1))}</div></div>
      <div class="hub-meter"><span></span></div>`;
    const name = row.querySelector('.hub-name');
    const use = row.querySelector('input[type=checkbox]');
    name.value = pick.name || '';
    use.checked = on;
    name.onchange = () => savePick('mics', d.deviceId, { name: name.value.trim(), label: d.label });
    use.onchange = () => {
      savePick('mics', d.deviceId, { use: use.checked, label: d.label });
      row.classList.toggle('off', !use.checked);
      if (use.checked) startMic(d, row);
      else {
        stopDevice(d.deviceId);
        row.querySelector('.hub-meter span').style.width = '0%';
      }
    };
    if (on) startMic(d, row);
    return row;
  }

  function fill(key, items, make, P, virtual, emptyMsg) {
    const box = list(key);
    box.replaceChildren();
    if (!items.length) box.innerHTML = `<p class="muted small">${emptyMsg}</p>`;
    items.forEach((d, i) => box.appendChild(make(d, i, P, virtual)));
    const used = items.filter((d) => ((make === camTile ? P.cams : P.mics)[d.deviceId]?.use ?? !virtual)).length;
    count(key, items.length, virtual ? ` · ${used} on` : '');
  }

  async function scan() {
    closeAll();
    for (const k of ['cams', 'vcams', 'mics', 'vmics']) list(k).innerHTML = '<p class="muted small">Looking…</p>';
    try {
      // A microphone request is enough to reveal every device's name; no camera opens here.
      const probe = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), 10000);
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      for (const k of ['cams', 'vcams', 'mics', 'vmics']) list(k).innerHTML = '<p class="muted small">No access. Allow cameras and microphones for Sapphire.</p>';
      return;
    }
    if (!active) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const P = prefs();
    P.cams = P.cams || {};
    P.mics = P.mics || {};
    const isVirtual = (d) => VIRTUAL.test(d.label || '');
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const ins = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    camDevs = cams;
    micDevs = ins;
    audioCtx = new AudioContext();
    fill('cams', cams.filter((d) => !isVirtual(d)), camTile, P, false, 'No cameras plugged in. Plug in a camera or capture card, then Refresh.');
    fill('vcams', cams.filter(isVirtual), camTile, P, true, 'None.');
    fill('mics', ins.filter((d) => !isVirtual(d)), micRow, P, false, 'No microphones found.');
    fill('vmics', ins.filter(isVirtual), micRow, P, true, 'None.');
    renderPhones();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      for (const m of meters) {
        m.an.getFloatTimeDomainData(m.buf);
        let peak = 0;
        for (const v of m.buf) peak = Math.max(peak, Math.abs(v));
        m.level = Math.max(peak, m.level * 0.9); // quick up, slow down
        const db = 20 * Math.log10(m.level || 1e-6); // -60..0 dB → 0..100%
        m.bar.style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
        m.bar.classList.toggle('hot', db > -3);
      }
    };
    draw();
  }

  // ------------------------------------------------------------------ phones joined as cameras
  // A phone in "Camera for the Hub" dials this computer's code and sends a live preview as
  // a video call. Kept even while the Hub screen is closed, so tiles appear straight away.
  const phones = new Map(); // code -> { call, stream }
  function renderPhones() {
    const box = list('phones');
    box.replaceChildren();
    const P = prefs();
    const picks = P.phones || {};
    if (!phones.size) {
      box.innerHTML = `<p class="muted small">On a phone: Sapphire → <b>Camera for the Hub</b> → enter this computer's code <b class="hub-code">${esc(link.code)}</b>. It shows up here with a live preview.</p>`;
    }
    for (const [code, ph] of phones) {
      const pick = picks[code] || {};
      const tile = document.createElement('div');
      tile.className = 'hub-cam' + (pick.use === false ? ' off' : '');
      tile.innerHTML = `<div class="hub-video"><video muted playsinline autoplay></video><span class="hub-res">${ph.stream ? 'Live preview' : 'Connecting…'}</span></div>
        <div class="hub-row"><input class="hub-name" maxlength="30" placeholder="Phone ${esc(code)}"><label class="hub-use"><input type="checkbox"> Use</label></div>
        <div class="muted small hub-dev">Phone · ${esc(code)}</div>`;
      const v = tile.querySelector('video');
      if (ph.stream) {
        v.srcObject = ph.stream;
        v.onloadedmetadata = () => (tile.querySelector('.hub-res').textContent = `Preview ${v.videoWidth}×${v.videoHeight}`);
      }
      const name = tile.querySelector('.hub-name');
      const use = tile.querySelector('input[type=checkbox]');
      name.value = pick.name || '';
      use.checked = pick.use !== false;
      name.onchange = () => savePick('phones', code, { name: name.value.trim() });
      use.onchange = () => {
        savePick('phones', code, { use: use.checked });
        tile.classList.toggle('off', !use.checked);
      };
      box.appendChild(tile);
    }
    count('phones', phones.size);
  }

  // ------------------------------------------------------------------ setup → studio
  // What Setup has ticked and opened, named as the user named it.
  function selection() {
    const P = prefs();
    const cams = [];
    const mics = [];
    // Unnamed inputs are numbered among what's picked: Camera 1, Camera 2, Mic 1…
    for (const d of camDevs) {
      const s = open.get(d.deviceId);
      if (s) cams.push({ name: P.cams?.[d.deviceId]?.name || `Camera ${cams.length + 1}`, label: d.label, stream: s });
    }
    for (const [code, ph] of phones) {
      if (ph.stream && (P.phones?.[code]?.use ?? true)) cams.push({ name: P.phones?.[code]?.name || `Phone ${code}`, label: `Phone ${code}`, stream: ph.stream, phone: true });
    }
    for (const d of micDevs) {
      const s = open.get(d.deviceId);
      if (s) mics.push({ name: P.mics?.[d.deviceId]?.name || `Mic ${mics.length + 1}`, label: d.label, stream: s });
    }
    return { cams, mics };
  }
  function summary() {
    const s = selection();
    view.querySelector('[data-h-sum]').textContent = `${s.cams.length} camera${s.cams.length === 1 ? '' : 's'} · ${s.mics.length} mic${s.mics.length === 1 ? '' : 's'} selected`;
  }
  const studio = createStudio({ root: view.querySelector('.hub-studio'), link, hub, remote, toast, audioCtx: () => audioCtx });
  function setMode(m) {
    if (m === 'studio' && studio.recording) return;
    mode = m;
    const inStudio = m === 'studio';
    view.classList.toggle('in-studio', inStudio);
    view.querySelector('.hub-body').hidden = inStudio;
    view.querySelector('.hub-next').hidden = inStudio;
    view.querySelector('[data-h=refresh]').hidden = inStudio;
    view.querySelector('[data-h-back]').textContent = inStudio ? 'Setup' : 'Home';
    view.querySelector('[data-h-title]').textContent = inStudio ? 'Hub · Studio' : 'Hub · Setup';
    if (inStudio) studio.enter(selection());
    else studio.leave();
  }
  setInterval(() => active && mode === 'setup' && summary(), 1000);

  view.addEventListener('click', (e) => {
    const h = e.target.closest('[data-h]')?.dataset.h;
    if (h === 'back') {
      if (studio.recording && !confirm('Stop recording?')) return;
      if (mode === 'studio') setMode('setup');
      else onHome();
    } else if (h === 'refresh') scan();
    else if (h === 'next') setMode('studio');
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => active && scan());

  return {
    enter() {
      if (active) return;
      active = true;
      view.hidden = false;
      scan();
    },
    leave() {
      if (!active) return;
      if (mode === 'studio') setMode('setup');
      active = false;
      view.hidden = true;
      closeAll();
    },
    linkStatus: () => studio.linkStatus(),
    // A phone camera called in (see link.onCall). Answer without sending anything back.
    onCall(code, call) {
      phones.get(code)?.call?.close?.();
      const ph = { call, stream: null };
      phones.set(code, ph);
      call.on('stream', (s) => {
        ph.stream = s;
        if (active) renderPhones();
      });
      const gone = () => {
        if (phones.get(code) !== ph) return;
        phones.delete(code);
        if (active) renderPhones();
      };
      call.on('close', gone);
      call.on('error', gone);
      call.answer();
      if (active) renderPhones();
      toast(`Phone camera ${code} joined`);
    },
    // Phone disconnected entirely.
    phoneLeft(code) {
      const ph = phones.get(code);
      if (!ph) return;
      ph.call?.close?.();
      phones.delete(code);
      if (active) renderPhones();
    },
  };
}
