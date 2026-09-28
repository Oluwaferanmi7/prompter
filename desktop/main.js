// Sapphire for Windows: the Sapphire web app in its own window, plus the Hub (cameras and
// mics plugged into this computer). It loads the live app, so web updates arrive on their
// own and the service worker keeps it working offline. The few native abilities the Hub
// needs (writing recordings to disk) come through preload.js, are offered to the app's own
// origin only, and can only touch the recordings folder.
//
//   npm start            the live app
//   npm run dev          http://localhost:5173 (node tools/serve.mjs in the repo root)
//   npm run dist         build the Windows installer into dist/
//   --selftest           hidden: open the Hub, report what it sees, quit
//   --selftest=record    hidden: also go to Studio, record 4 s, report the files, quit
const { app, BrowserWindow, session, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DEV = process.argv.includes('--dev');
const SELFTEST = process.argv.some((a) => a.startsWith('--selftest'));
const SELFTEST_RECORD = process.argv.includes('--selftest=record');
const START = DEV ? 'http://localhost:5173/' : 'https://oluwaferanmi7.github.io/prompter/';
const APP_ORIGIN = new URL(START).origin;
const MEDIA_OK = new Set(['media', 'fullscreen', 'clipboard-sanitized-write']);

if (!app.requestSingleInstanceLock()) app.quit();

// ------------------------------------------------------------------ recordings folder
// Default: Videos\Sapphire. Changeable from the Studio screen; remembered in settings.json.
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
function recRoot() {
  if (SELFTEST) return path.join(os.tmpdir(), 'sapphire-selftest-rec');
  return loadSettings().recRoot || path.join(app.getPath('videos'), 'Sapphire');
}
// File and folder names come from the app: keep them plain, never a path.
const safeName = (s) =>
  String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\.+$/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120) || 'untitled';
const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const takes = new Map(); // take token -> folder
const files = new Map(); // file handle -> { fd, path }
let nextId = 1;

function fromApp(e) {
  try {
    return new URL(e.senderFrame.url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}
function handle(name, fn) {
  ipcMain.handle(name, (e, ...args) => {
    if (!fromApp(e)) throw new Error('not allowed');
    return fn(...args);
  });
}

handle('rec:root', () => recRoot());
handle('rec:chooseRoot', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Where should Sapphire save recordings?', defaultPath: recRoot(), properties: ['openDirectory', 'createDirectory'] });
  if (!r.canceled && r.filePaths[0]) saveSettings({ ...loadSettings(), recRoot: r.filePaths[0] });
  return recRoot();
});
// A new take folder, e.g. "2026-09-28 1512 Episode 98". Returns a token, not a path.
handle('rec:begin', (name) => {
  const root = recRoot();
  let dir = path.join(root, safeName(name));
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, safeName(name) + ` (${i})`);
  fs.mkdirSync(dir, { recursive: true });
  const token = 't' + nextId++;
  takes.set(token, dir);
  return { token, folder: dir };
});
handle('rec:open', (token, file) => {
  const dir = takes.get(token);
  if (!dir) throw new Error('unknown take');
  const p = path.join(dir, safeName(file));
  if (!inside(dir, p)) throw new Error('bad name');
  const id = nextId++;
  files.set(id, { fd: fs.openSync(p, 'a'), path: p });
  return id;
});
handle('rec:write', (id, data) => {
  const f = files.get(id);
  if (!f) throw new Error('closed');
  fs.writeSync(f.fd, Buffer.from(data));
  return true;
});
handle('rec:close', (id) => {
  const f = files.get(id);
  if (!f) return null;
  fs.closeSync(f.fd);
  files.delete(id);
  return fs.statSync(f.path).size;
});
handle('rec:writeText', (token, file, text) => {
  const dir = takes.get(token);
  if (!dir) throw new Error('unknown take');
  const p = path.join(dir, safeName(file));
  if (!inside(dir, p)) throw new Error('bad name');
  fs.writeFileSync(p, String(text));
  return true;
});
handle('rec:reveal', (token) => {
  const dir = token ? takes.get(token) : recRoot();
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  }
  return true;
});

// ------------------------------------------------------------------ window
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
      backgroundThrottling: false, // keep recording smoothly when the window isn't focused
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
          `(async () => {
            const w = (ms) => new Promise(r => setTimeout(r, ms));
            const r = { desktop: !!window.sapphireDesktop, hash: location.hash,
              cams: [...document.querySelectorAll('.hub-cam')].map(t => t.querySelector('.hub-dev').textContent + ' | ' + t.querySelector('.hub-res').textContent),
              mics: [...document.querySelectorAll('.hub-mic')].map(m => m.querySelector('.muted').textContent + ' | meter ' + m.querySelector('.hub-meter span').style.width) };
            if (${SELFTEST_RECORD}) {
              document.querySelector('#hub [data-h=next]')?.click();
              await w(2500);
              r.studio = document.querySelector('#hub .hub-studio')?.innerText.slice(0, 300);
              document.querySelector('#hub [data-st=rec]')?.click();
              await w(4500);
              r.during = document.querySelector('#hub [data-st=time]')?.textContent;
              document.querySelector('#hub [data-st=rec]')?.click();
              await w(3000);
              r.after = document.querySelector('#hub [data-st=saved]')?.innerText;
            }
            return r;
          })()`
        )
        .catch((e) => ({ error: String(e) }));
      if (SELFTEST_RECORD) {
        const root = recRoot();
        out.files = [];
        for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
          for (const f of fs.readdirSync(path.join(root, d))) out.files.push(`${d}/${f} ${fs.statSync(path.join(root, d, f)).size} bytes`);
        }
      }
      fs.writeFileSync(path.join(os.tmpdir(), 'sapphire-selftest.json'), JSON.stringify(out, null, 2));
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  // Camera and mic for the app itself only; everything else is refused.
  const allowed = (url) => {
    try {
      return new URL(url).origin === APP_ORIGIN; // check-handler origins arrive as "http://host/"
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowed(details.requestingUrl || wc.getURL()) && MEDIA_OK.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => allowed(requestingOrigin) && MEDIA_OK.has(permission));
  createWindow();
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
