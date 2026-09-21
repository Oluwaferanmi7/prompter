// Keep the prompter screen on. Native Wake Lock first; a muted looping video as a
// fallback (iOS home-screen apps ignored Wake Lock before iOS 18.4). Must be started
// from a user gesture.
import { MP4, WEBM } from '../vendor/nosleep-media.js';

let sentinel = null;
let video = null;
let wanted = false;

async function requestNative() {
  if (!('wakeLock' in navigator)) return false;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
    return true;
  } catch {
    return false;
  }
}

function startVideo() {
  if (!video) {
    video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.muted = true;
    video.loop = true;
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
    for (const [type, src] of [['webm', WEBM], ['mp4', MP4]]) {
      const s = document.createElement('source');
      s.src = src;
      s.type = `video/${type}`;
      video.appendChild(s);
    }
    video.addEventListener('timeupdate', () => {
      if (video.duration > 1 && video.currentTime > 0.5) video.currentTime = Math.random() * 0.4;
    });
    document.body.appendChild(video);
  }
  video.play().catch(() => {});
}

export async function keepAwake() {
  wanted = true;
  const ok = await requestNative();
  // Belt and braces: the video costs nothing and covers iOS standalone quirks.
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!ok || standalone) startVideo();
}

export function releaseAwake() {
  wanted = false;
  sentinel?.release().catch(() => {});
  sentinel = null;
  video?.pause();
}

document.addEventListener('visibilitychange', () => {
  if (wanted && document.visibilityState === 'visible') {
    if (!sentinel) requestNative();
    if (video) video.play().catch(() => {});
  }
});
