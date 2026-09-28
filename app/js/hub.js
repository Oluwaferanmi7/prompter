// Hub (desktop app only): the computer that the cameras and mics plug into. Stage 2 shows
// every camera and microphone this computer can see (capture cards appear as cameras), with
// live previews and level meters, and lets you pick and name the ones this shoot uses.
// Recording comes next (stage 3).
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Only in the desktop app (its preload sets window.sapphireDesktop), or ?hub on localhost for testing.
export const hubAvailable = () => !!window.sapphireDesktop || (['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('hub'));

export function createHub({ toast, onHome }) {
  const view = $('hub');
  view.innerHTML = `
    <header class="hub-top">
      <button class="back-btn" data-h="home"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg><span>Home</span></button>
      <div class="hub-title">Hub</div>
      <button class="btn ghost small" data-h="refresh">Refresh</button>
    </header>
    <div class="hub-body">
      <p class="muted hub-lede">Everything plugged into this computer. Tick what this shoot uses and give it a name. Capture cards show up as cameras.</p>
      <section><div class="set-title">Cameras</div><div class="hub-grid" data-list="video"></div></section>
      <section><div class="set-title">Microphones</div><div class="hub-mics" data-list="audio"></div></section>
      <p class="muted small hub-note">Recording from the Hub is the next stage.</p>
    </div>`;
  const vids = view.querySelector('[data-list=video]');
  const mics = view.querySelector('[data-list=audio]');
  let active = false;
  let streams = [];
  let audioCtx = null;
  let raf = 0;
  const meters = [];

  const prefs = () => store.getPrefs().hub || { cams: {}, mics: {} };
  function savePick(kind, id, patch) {
    const p = store.getPrefs();
    const h = p.hub || { cams: {}, mics: {} };
    h[kind][id] = { ...(h[kind][id] || {}), ...patch };
    p.hub = h;
    store.savePrefs(p);
  }

  function closeAll() {
    cancelAnimationFrame(raf);
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streams = [];
    open?.forEach((st) => st.getTracks().forEach((t) => t.stop()));
    open?.clear();
    meters.length = 0;
    audioCtx?.close().catch(() => {});
    audioCtx = null;
  }

  // Studio computers are full of virtual devices (NDI, vMix, OBS, Voicemeeter…). They're
  // listed but off by default; the real camera/mic comes first. Opening a virtual camera
  // with nothing feeding it can hang, so every device gets a time limit and only ticked
  // devices are opened at all.
  const VIRTUAL = /\b(NDI|vMix|OBS|Virtual|Voicemeeter|VB-Audio|VAIO|Snap Camera|ManyCam|XSplit|Streamlabs|Camo|Iriun|DroidCam)\b/i;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('timeout'), { name: 'Timeout' })), ms))]);
  const open = new Map(); // deviceId -> MediaStream

  function stopDevice(id) {
    open.get(id)?.getTracks().forEach((t) => t.stop());
    open.delete(id);
    const i = meters.findIndex((m) => m.id === id);
    if (i >= 0) meters.splice(i, 1);
  }

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

  function group(title, items, render, host) {
    if (!items.length) return;
    if (title) host.insertAdjacentHTML('beforeend', `<div class="hub-sub muted small">${title}</div>`);
    items.forEach(render);
  }

  async function scan() {
    closeAll();
    open.forEach((st) => st.getTracks().forEach((t) => t.stop()));
    open.clear();
    vids.innerHTML = mics.innerHTML = '<p class="muted small">Looking…</p>';
    try {
      // A microphone request is enough to reveal every device's name; no camera gets opened here.
      const probe = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), 10000);
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      vids.innerHTML = mics.innerHTML = '<p class="muted small">No access. Allow cameras and microphones for Sapphire.</p>';
      return;
    }
    if (!active) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const P = prefs();
    const isVirtual = (d) => VIRTUAL.test(d.label || '');
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const ins = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    vids.innerHTML = cams.length ? '' : '<p class="muted small">No cameras found. Plug in a camera or capture card, then Refresh.</p>';
    mics.innerHTML = ins.length ? '' : '<p class="muted small">No microphones found.</p>';
    audioCtx = new AudioContext();

    let camNo = 0;
    const camTile = (d) => {
      const i = camNo++;
      const pick = P.cams[d.deviceId] || {};
      const on = pick.use ?? !isVirtual(d);
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
      vids.appendChild(tile);
      if (on) startCam(d, tile);
    };
    group('', cams.filter((d) => !isVirtual(d)), camTile, vids);
    group('Virtual cameras (from NDI, vMix, OBS…): off unless you tick them', cams.filter(isVirtual), camTile, vids);

    let micNo = 0;
    const micRow = (d) => {
      const i = micNo++;
      const pick = P.mics[d.deviceId] || {};
      const on = pick.use ?? !isVirtual(d);
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
      mics.appendChild(row);
      if (on) startMic(d, row);
    };
    group('', ins.filter((d) => !isVirtual(d)), micRow, mics);
    group('Virtual inputs (Voicemeeter, NDI…): off unless you tick them', ins.filter(isVirtual), micRow, mics);

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

  view.addEventListener('click', (e) => {
    const h = e.target.closest('[data-h]')?.dataset.h;
    if (h === 'home') onHome();
    else if (h === 'refresh') scan();
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
      active = false;
      view.hidden = true;
      closeAll();
    },
  };
}
