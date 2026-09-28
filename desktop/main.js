// Sapphire for Windows: the Sapphire web app in its own window, plus the Hub (cameras and
// mics plugged into this computer). It loads the live app, so web updates arrive on their
// own and the service worker keeps it working offline. Native abilities (recording with
// FFmpeg, from stage 3) come through preload.js and are offered to the app's own origin only.
//
//   npm start            the live app
//   npm run dev          http://localhost:5173 (node tools/serve.mjs in the repo root)
//   npm run dist         build the Windows installer into dist/
const { app, BrowserWindow, session, shell } = require('electron');
const path = require('path');

const DEV = process.argv.includes('--dev');
const SELFTEST = process.argv.includes('--selftest'); // open the Hub, print what it sees, quit
const START = DEV ? 'http://localhost:5173/' : 'https://oluwaferanmi7.github.io/prompter/';
const APP_ORIGIN = new URL(START).origin;
const MEDIA_OK = new Set(['media', 'fullscreen', 'clipboard-sanitized-write']);

if (!app.requestSingleInstanceLock()) app.quit();

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0b1628',
    title: 'Sapphire',
    show: !SELFTEST, // self-test runs out of sight
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(START + (SELFTEST ? '?hub#/hub' : ''));

  // Anything outside the app (Google sign-in, links) opens in the normal browser.
  // Google refuses sign-in inside embedded app windows anyway.
  const outside = (url) => {
    try {
      return new URL(url).origin !== APP_ORIGIN;
    } catch {
      return true;
    }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (outside(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  if (SELFTEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 6000));
      const out = await win.webContents
        .executeJavaScript(
          `(async () => ({ desktop: !!window.sapphireDesktop, hash: location.hash,
              cams: [...document.querySelectorAll('.hub-cam')].map(t => t.querySelector('.hub-dev').textContent + ' | ' + t.querySelector('.hub-res').textContent),
              mics: [...document.querySelectorAll('.hub-mic')].map(m => m.querySelector('.muted').textContent + ' | meter ' + m.querySelector('.hub-meter span').style.width),
              note: (document.getElementById('hub')?.innerText || '').slice(0, 300),
              devices: (await navigator.mediaDevices.enumerateDevices()).map(x => x.kind + ':' + (x.label || '?')) }))()`
        )
        .catch((e) => ({ error: String(e) }));
      require('fs').writeFileSync(path.join(require('os').tmpdir(), 'sapphire-selftest.json'), JSON.stringify(out, null, 2));
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  // Camera and mic for the app itself only; everything else is refused.
  const trace = (...a) => SELFTEST && require('fs').appendFileSync(path.join(require('os').tmpdir(), 'sapphire-selftest.log'), a.join(' ') + '\n');
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    let origin = '';
    try {
      origin = new URL(details.requestingUrl || wc.getURL()).origin;
    } catch {}
    const ok = origin === APP_ORIGIN && MEDIA_OK.has(permission);
    trace('request', permission, origin, JSON.stringify(details.mediaTypes || []), ok);
    callback(ok);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    let origin = '';
    try {
      origin = new URL(requestingOrigin).origin; // arrives as "http://host/" (trailing slash)
    } catch {}
    const ok = origin === APP_ORIGIN && MEDIA_OK.has(permission);
    trace('check', permission, requestingOrigin, ok);
    return ok;
  });
  createWindow();
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
