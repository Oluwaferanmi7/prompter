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
    meters.length = 0;
    audioCtx?.close().catch(() => {});
    audioCtx = null;
  }

  async function scan() {
    closeAll();
    vids.innerHTML = mics.innerHTML = '<p class="muted small">Looking…</p>';
    try {
      // One permission prompt reveals device names; then each device opens on its own.
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      vids.innerHTML = mics.innerHTML = '<p class="muted small">No access. Allow cameras and microphones for Sapphire.</p>';
      return;
    }
    if (!active) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const P = prefs();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const ins = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    vids.innerHTML = cams.length ? '' : '<p class="muted small">No cameras found. Plug in a camera or capture card, then Refresh.</p>';
    mics.innerHTML = ins.length ? '' : '<p class="muted small">No microphones found.</p>';

    cams.forEach((d, i) => {
      const pick = P.cams[d.deviceId] || {};
      const tile = document.createElement('div');
      tile.className = 'hub-cam' + (pick.use === false ? ' off' : '');
      tile.innerHTML = `<div class="hub-video"><video muted playsinline autoplay></video><span class="hub-res"></span></div>
        <div class="hub-row"><input class="hub-name" maxlength="30" placeholder="Camera ${i + 1}"><label class="hub-use"><input type="checkbox"> Use</label></div>
        <div class="muted small hub-dev">${esc(d.label || 'Camera ' + (i + 1))}</div>`;
      const name = tile.querySelector('.hub-name');
      const use = tile.querySelector('input[type=checkbox]');
      name.value = pick.name || '';
      use.checked = pick.use !== false;
      name.onchange = () => savePick('cams', d.deviceId, { name: name.value.trim(), label: d.label });
      use.onchange = () => {
        savePick('cams', d.deviceId, { use: use.checked, label: d.label });
        tile.classList.toggle('off', !use.checked);
      };
      vids.appendChild(tile);
      navigator.mediaDevices
        .getUserMedia({ video: { deviceId: { exact: d.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } })
        .then((s) => {
          if (!active) return s.getTracks().forEach((t) => t.stop());
          streams.push(s);
          tile.querySelector('video').srcObject = s;
          const st = s.getVideoTracks()[0].getSettings();
          tile.querySelector('.hub-res').textContent = `${st.width}×${st.height} · ${Math.round(st.frameRate || 0)} fps`;
        })
        .catch((err) => {
          tile.querySelector('.hub-res').textContent = err?.name === 'NotReadableError' ? 'In use by another app' : "Can't open";
          tile.classList.add('bad');
        });
    });

    audioCtx = new AudioContext();
    ins.forEach((d, i) => {
      const pick = P.mics[d.deviceId] || {};
      const row = document.createElement('div');
      row.className = 'hub-mic' + (pick.use === false ? ' off' : '');
      row.innerHTML = `<label class="hub-use"><input type="checkbox"></label>
        <div class="hub-mic-txt"><input class="hub-name" maxlength="30" placeholder="Mic ${i + 1}"><div class="muted small">${esc(d.label || 'Microphone ' + (i + 1))}</div></div>
        <div class="hub-meter"><span></span></div>`;
      const name = row.querySelector('.hub-name');
      const use = row.querySelector('input[type=checkbox]');
      name.value = pick.name || '';
      use.checked = pick.use !== false;
      name.onchange = () => savePick('mics', d.deviceId, { name: name.value.trim(), label: d.label });
      use.onchange = () => {
        savePick('mics', d.deviceId, { use: use.checked, label: d.label });
        row.classList.toggle('off', !use.checked);
      };
      mics.appendChild(row);
      navigator.mediaDevices
        .getUserMedia({ audio: { deviceId: { exact: d.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        .then((s) => {
          if (!active || !audioCtx) return s.getTracks().forEach((t) => t.stop());
          streams.push(s);
          const an = audioCtx.createAnalyser();
          an.fftSize = 1024;
          audioCtx.createMediaStreamSource(s).connect(an);
          meters.push({ an, bar: row.querySelector('.hub-meter span'), buf: new Float32Array(an.fftSize), level: 0 });
        })
        .catch(() => row.classList.add('bad'));
    });
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
