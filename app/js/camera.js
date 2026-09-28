// "Record yourself": the camera fills the screen, the script scrolls over the top part
// (close to the front lens, so your eyes stay near the camera), and Record saves the video
// on this device. It's the normal teleprompter underneath, so speed, voice glide, remotes
// and the take log all work; the take log gets the exact record start/stop on the same
// clock as the video.
import * as store from './store.js';
import * as lib from './library.js';
import * as recs from './recstore.js';
import { keepAwake } from './wakelock.js';

const $ = (id) => document.getElementById(id);
const TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const mb = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB');

// Test bench only (?bench=…&fakecam): a moving test pattern and a tone instead of a real camera.
function fakeStream() {
  const c = Object.assign(document.createElement('canvas'), { width: 720, height: 1280 });
  const g = c.getContext('2d');
  let f = 0;
  setInterval(() => {
    g.fillStyle = '#13223a';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#c5a94a';
    g.beginPath();
    g.arc(360 + 200 * Math.sin(f / 20), 800, 120, 0, 7);
    g.fill();
    g.fillStyle = '#eaf3ff';
    g.font = '64px sans-serif';
    g.fillText(`frame ${f++}`, 40, 1200);
  }, 33);
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  const dest = ac.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  return new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
}
const fake = store.NS && new URLSearchParams(location.search).has('fakecam');

export function createCamera({ engine, log, toast }) {
  const view = $('prompter');
  const video = $('p-cam');
  const ui = $('p-camui');
  const recBtn = ui.querySelector('[data-cam=rec]');
  const clock = ui.querySelector('[data-cam=time]');
  const flipBtn = ui.querySelector('[data-cam=flip]');
  let stream = null;
  let facing = store.getPrefs().camFacing || 'user';
  let active = false;
  let rec = null; // { mr, id, started, n, pending }
  let tick = 0;

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }
  async function open() {
    stopStream();
    try {
      stream = fake
        ? fakeStream()
        : await navigator.mediaDevices.getUserMedia({
            video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
            // Natural voice: no phone-call processing on the recording.
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          });
    } catch (err) {
      toast(err?.name === 'NotAllowedError' ? 'Camera blocked. Allow camera and microphone for this app in Settings.' : "Couldn't open the camera.");
      return false;
    }
    if (!active) return stopStream(), false;
    video.srcObject = stream;
    video.classList.toggle('front', facing === 'user');
    video.play().catch(() => {});
    return true;
  }

  // ------------------------------------------------------------------ recording
  async function start() {
    if (rec || !stream) return;
    const mime = TYPES.find((t) => window.MediaRecorder?.isTypeSupported?.(t));
    if (!mime) return toast("This browser can't record video.");
    navigator.storage?.persist?.().catch(() => {});
    const est = await navigator.storage?.estimate?.().catch(() => null);
    if (est && est.quota - est.usage < 300e6) toast('Low storage: long takes may not fit. Share and delete old recordings.');
    const s = lib.get(engine.script?.id);
    const id = store.uid();
    const started = Date.now();
    const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 });
    rec = { mr, id, started, n: 0, pending: Promise.resolve() };
    await recs.begin({ id, started, ended: started, mime, title: s?.title || 'Take', scriptId: s?.id || null });
    mr.ondataavailable = (e) => {
      if (!e.data?.size) return;
      const n = rec.n++;
      rec.pending = rec.pending.then(() => recs.chunk(id, n, e.data)).catch(() => toast('Storage is full. Recording saved up to here.'));
    };
    mr.onstop = async () => {
      const r = rec;
      rec = null;
      await r.pending;
      await recs.end(r.id, { ended: Date.now() });
      update();
      toast('Saved. Recordings → Share to save it to Photos or AirDrop.');
    };
    mr.start(1000);
    const set = stream.getVideoTracks()[0]?.getSettings?.() || {};
    log.event('rec', { on: true, id, mime, w: set.width, h: set.height });
    keepAwake();
    // Rolling starts with the take, unless voice glide is steering.
    if (!engine.playing && !engine.voice) engine.play();
    tick = setInterval(update, 250);
    update();
  }
  function stop() {
    if (!rec || rec.mr.state === 'inactive') return;
    log.event('rec', { on: false, id: rec.id, ms: Date.now() - rec.started });
    rec.mr.stop();
    engine.pause();
    clearInterval(tick);
  }

  function update() {
    const on = !!rec;
    recBtn.classList.toggle('on', on);
    recBtn.setAttribute('aria-label', on ? 'Stop recording' : 'Record');
    clock.hidden = !on;
    if (on) clock.textContent = fmt(Date.now() - rec.started);
    flipBtn.disabled = on;
    view.classList.toggle('rec', on);
  }

  ui.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-cam]')?.dataset.cam;
    e.stopPropagation();
    if (a === 'rec') rec ? stop() : start();
    else if (a === 'flip' && !rec) {
      facing = facing === 'user' ? 'environment' : 'user';
      const p = store.getPrefs();
      p.camFacing = facing;
      store.savePrefs(p);
      open();
    } else if (a === 'list') openList();
  });
  // Tapping the camera area shouldn't toggle the teleprompter bar underneath.
  ui.addEventListener('pointerdown', (e) => e.target.closest('[data-cam]') && e.stopPropagation());

  // ------------------------------------------------------------------ recordings list
  async function openList() {
    const sheet = document.createElement('div');
    sheet.className = 'modal';
    sheet.innerHTML = `<div class="modal-card logs-card"><div class="a-title">Recordings</div>
      <p class="muted small">Saved on this device. Share to save to Photos, AirDrop or Drive, then delete here to free space.</p>
      <ul class="log-list"><li class="muted small">Loading…</li></ul><button class="cancel">Close</button></div>`;
    sheet.querySelector('.cancel').onclick = () => sheet.remove();
    sheet.addEventListener('click', (e) => e.target === sheet && sheet.remove());
    view.appendChild(sheet);
    const ul = sheet.querySelector('.log-list');
    const all = (await recs.list()).filter((r) => r.id !== rec?.id);
    ul.replaceChildren();
    if (!all.length) ul.innerHTML = '<li class="muted small">No recordings yet. Tap the red button to record.</li>';
    for (const r of all) {
      const li = document.createElement('li');
      li.className = 'rec-item';
      li.innerHTML = `<div class="rec-txt"><div class="si-title"><span></span></div><div class="si-meta"></div></div>
        <button class="btn small primary" data-r="share">Share</button><button class="btn small ghost" data-r="del">Delete</button>`;
      li.querySelector('.si-title span').textContent = r.title;
      li.querySelector('.si-meta').textContent = `${new Date(r.started).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${fmt(r.ended - r.started)} · ${mb(r.bytes)}${r.recovered ? ' · recovered' : ''}`;
      li.querySelector('[data-r=share]').onclick = async () => {
        const f = await recs.file(r.id);
        if (!f) return toast('That recording is gone.');
        try {
          if (navigator.canShare?.({ files: [f] })) return await navigator.share({ files: [f], title: r.title });
        } catch (err) {
          if (err?.name === 'AbortError') return;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(f);
        a.download = f.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      };
      li.querySelector('[data-r=del]').onclick = async () => {
        if (!confirm(`Delete this recording of “${r.title}” from this device? Make sure you've saved it somewhere first.`)) return;
        await recs.remove(r.id);
        li.remove();
      };
      ul.appendChild(li);
    }
  }

  return {
    get active() {
      return active;
    },
    get recording() {
      return !!rec;
    },
    async enter() {
      if (active) return;
      active = true;
      view.classList.add('cam');
      ui.hidden = false;
      video.hidden = false;
      update();
      if (!(await open())) {
        // No camera: stay in the mode so the message is visible; Home gets you out.
        clock.hidden = true;
      }
    },
    leave() {
      if (!active) return;
      if (rec) stop();
      active = false;
      view.classList.remove('cam', 'rec');
      ui.hidden = true;
      video.hidden = true;
      stopStream();
    },
  };
}
