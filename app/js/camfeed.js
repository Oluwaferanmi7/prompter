// "Camera for the Hub": this phone becomes one of the Hub's cameras. It joins the Hub
// computer with that computer's code and sends a live preview (a video call over the same
// link the remotes use), so the Hub can frame and monitor it. Full-quality recording on the
// phone, started and stopped by the Hub, is the next stage.
import * as store from './store.js';
import { keepAwake } from './wakelock.js';
import { fake, fakeStream } from './camera.js';

const $ = (id) => document.getElementById(id);
// Preview only: keep it light so it doesn't fight the network.
const PREVIEW = { maxBitrate: 1_200_000, maxHeight: 720 };

export function createCamFeed({ link, hub, toast, onHome }) {
  const view = $('camfeed');
  view.innerHTML = `
    <video class="cf-video" playsinline muted autoplay></video>
    <div class="cf-top">
      <button class="chip home-chip" data-f="home" aria-label="Home"><svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10"/></svg></button>
      <button class="pill" data-f="code"><span class="dot"></span><span data-status>Not connected</span></button>
      <button class="chip" data-f="flip" aria-label="Switch camera"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><path d="M9 13a3 3 0 0 1 5-2M15 13a3 3 0 0 1-5 2"/></svg></button>
    </div>
    <div class="cf-ask" hidden>
      <div class="cf-card">
        <b>Camera for the Hub</b>
        <p class="muted small">Enter the code shown in the Hub on the computer.</p>
        <input class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="ABCD">
        <div class="status-line" data-err></div>
      </div>
    </div>`;
  const video = view.querySelector('video');
  const ask = view.querySelector('.cf-ask');
  const input = ask.querySelector('input');
  const status = view.querySelector('[data-status]');
  const pill = view.querySelector('.pill');
  let active = false;
  let stream = null;
  let call = null;
  let facing = store.getPrefs().feedFacing || 'environment';
  let watch = 0;

  const hubCode = () => store.getPrefs().hubCode || '';
  function setHubCode(c) {
    const p = store.getPrefs();
    p.hubCode = c;
    store.savePrefs(p);
  }

  async function openCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    try {
      stream = fake
        ? fakeStream()
        : await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      toast(err?.name === 'NotAllowedError' ? 'Camera blocked. Allow camera and microphone for this app in Settings.' : "Couldn't open the camera.");
      return;
    }
    if (!active) return stream.getTracks().forEach((t) => t.stop());
    video.srcObject = stream;
    video.classList.toggle('front', facing === 'user');
    video.play().catch(() => {});
    hangUp();
    tick();
  }

  function hangUp() {
    try {
      call?.close();
    } catch {}
    call = null;
  }
  // Keep a call going while connected: iPhones drop links on lock, so redial as needed.
  function tick() {
    if (!active) return;
    const t = link.targetStatus;
    pill.className = 'pill ' + (t === 'connected' ? (call?.open ? 'ok' : 'wait') : t === 'idle' ? '' : t === 'notfound' ? 'bad' : 'wait');
    status.textContent = !link.targetCode ? 'Not connected' : t === 'connected' ? (call?.open ? `Live on Hub ${link.targetCode}` : `Joining Hub ${link.targetCode}…`) : t === 'notfound' ? `Hub ${link.targetCode} not found` : `Connecting to ${link.targetCode}…`;
    if (t === 'connected' && stream && !call) {
      call = link.callTarget(stream);
      if (call) {
        const mine = call;
        mine.on('close', () => call === mine && (call = null));
        mine.on('error', () => call === mine && (call = null));
        setTimeout(() => lighten(mine), 1500);
      }
    }
  }
  async function lighten(c) {
    const sender = c?.peerConnection?.getSenders?.().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    const h = sender.track.getSettings().height || 1080;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = PREVIEW.maxBitrate;
    params.encodings[0].scaleResolutionDownBy = Math.max(1, h / PREVIEW.maxHeight);
    await sender.setParameters(params).catch(() => {});
  }

  function connectTo(code) {
    setHubCode(code);
    hub.setRole('camera');
    link.connect(code);
    ask.hidden = true;
    tick();
  }
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (input.value.length < 4) return;
    const c = input.value;
    const err = ask.querySelector('[data-err]');
    if (!/^[A-HJ-KM-NP-Z2-9]{4}$/.test(c)) return (err.textContent = 'Codes are 4 letters/numbers, like K7QM.');
    if (c === link.code) return (err.textContent = "That's this phone's own code.");
    input.blur();
    connectTo(c);
  });

  view.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (f === 'home') onHome();
    else if (f === 'code') {
      ask.hidden = false;
      input.value = '';
      setTimeout(() => input.focus(), 50);
    } else if (f === 'flip') {
      facing = facing === 'user' ? 'environment' : 'user';
      const p = store.getPrefs();
      p.feedFacing = facing;
      store.savePrefs(p);
      openCamera();
    }
  });

  return {
    linkStatus: () => active && tick(),
    enter() {
      if (active) return;
      active = true;
      view.hidden = false;
      keepAwake();
      watch = setInterval(tick, 2000);
      const code = hubCode();
      if (code) connectTo(code);
      else ask.hidden = false;
      openCamera();
    },
    leave() {
      if (!active) return;
      active = false;
      view.hidden = true;
      clearInterval(watch);
      hangUp();
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
      // Stop being a camera: drop the Hub link, and go back to the remembered remote if any.
      if (hub.role === 'camera') {
        hub.setRole('remote');
        link.disconnect();
        const back = store.getRemoteCode();
        if (back) link.connect(back);
      }
    },
  };
}
