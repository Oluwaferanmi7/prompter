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
//   --selftest=record    hidden: also go to Studio, record 4 s, finish the files, report, quit
const { app, BrowserWindow, session, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
// Bundled FFmpeg. Inside the installed app it lives next to the asar, not in it.
const FFMPEG = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

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
    return fn.apply(e, args); // `this` = the event, for calls that report progress
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
// ------------------------------------------------------------------ finishing a take
// After Stop, make every file usable in normal players and editors, without losing a bit:
//   video: the recorder's streaming MP4 (no index, can't be scrubbed) → normal MP4 with the
//          index at the front. Same frames, copied, never re-encoded.
//   audio: WebM holding 32-bit float PCM → WAV, same samples (+ an optional MP3 copy).
// The recorder's file moves to Originals\ first and is never changed. Each new file is
// checked against it (checksum of the actual video frames / audio samples); if they don't
// match, the original goes back under its normal name and the new one is thrown away.
function ffmpeg(args, { onTime } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:2', ...args], { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err += d;
      const m = /out_time_us=(\d+)\s*$/m.exec(String(d));
      if (m && onTime) onTime(Number(m[1]) / 1000);
      if (err.length > 20000) err = err.slice(-10000);
    });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(err.split('\n').filter((l) => l && !l.includes('=')).slice(-3).join(' ') || `ffmpeg exit ${code}`))));
  });
}
// One hash per stream, of the packets themselves (video copied, audio as 32-bit float).
const hashArgs = (kind) => (kind === 'video' ? ['-map', '0:v', '-c', 'copy'] : ['-map', '0:a', '-c:a', 'pcm_f32le']);
const hashOf = (text) => text.trim().split(/\r?\n/).filter(Boolean).join('|');

async function finishOne(dir, item, opts, report) {
  const file = safeName(item.file);
  const src = path.join(dir, file);
  const base = file.replace(/\.[^.]+$/, '');
  const origDir = path.join(dir, 'Originals');
  const orig = path.join(origDir, file);
  if (!fs.existsSync(src)) throw new Error('file missing');
  fs.mkdirSync(origDir, { recursive: true });
  fs.renameSync(src, orig);
  const video = item.kind === 'video';
  const outName = base + (video ? '.mp4' : '.wav');
  const out = path.join(dir, outName);
  const part = out + '.partial';
  const mp3Name = !video && opts.mp3 ? base + '.mp3' : null;
  const mp3Part = mp3Name && path.join(dir, mp3Name) + '.partial';
  const cleanup = () => {
    for (const p of [part, mp3Part]) if (p) fs.rmSync(p, { force: true });
  };
  try {
    const args = ['-y', '-i', orig];
    if (video) args.push('-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', part);
    else args.push('-map', '0:a', '-c:a', 'pcm_f32le', '-f', 'wav', part);
    if (mp3Part) args.push('-map', '0:a', '-c:a', 'libmp3lame', '-b:a', '320k', '-f', 'mp3', mp3Part);
    args.push(...hashArgs(item.kind), '-f', 'streamhash', '-hash', 'md5', '-');
    const before = hashOf(await ffmpeg(args, { onTime: (ms) => report(ms) }));
    const after = hashOf(await ffmpeg(['-i', part, ...hashArgs(item.kind), '-f', 'streamhash', '-hash', 'md5', '-']));
    if (!before || before !== after) throw new Error('check failed: the new file does not match the original');
    fs.renameSync(part, out);
    if (mp3Part) fs.renameSync(mp3Part, path.join(dir, mp3Name));
    return { file: outName, original: 'Originals/' + file, mp3: mp3Name || undefined, bytes: fs.statSync(out).size, md5: before.replace(/[^|]*MD5=/g, '') };
  } catch (err) {
    cleanup();
    if (!fs.existsSync(src)) fs.renameSync(orig, src); // put it back where it was
    try {
      fs.rmdirSync(origDir); // only if empty
    } catch {}
    throw err;
  }
}

// (token, [{ file, kind }], { mp3, durationMs }) → [{ file, ok, original?, mp3?, error? }]
// Progress arrives as 'rec:progress' events: { token, file, index, count, pct }.
handle('rec:finish', async function (token, items, opts = {}) {
  const dir = takes.get(token);
  if (!dir) throw new Error('unknown take');
  const sender = this.sender;
  const results = [];
  for (const [index, item] of items.entries()) {
    const send = (pct) => !sender.isDestroyed() && sender.send('rec:progress', { token, file: item.file, index, count: items.length, pct });
    send(0);
    try {
      const r = await finishOne(dir, item, { mp3: !!opts.mp3 }, (ms) => send(opts.durationMs ? Math.min(99, Math.round((ms / opts.durationMs) * 100)) : 0));
      results.push({ ok: true, from: item.file, ...r });
    } catch (err) {
      results.push({ ok: false, from: item.file, file: item.file, error: String(err?.message || err) });
    }
    send(100);
  }
  return results;
});
handle('rec:canFinish', () => fs.existsSync(FFMPEG));

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
              await w(1500);
              document.querySelector('#hub [data-mode=teleprompter]')?.click(); // record with this computer as the teleprompter
              await w(1000);
              r.studio = document.querySelector('#hub .hub-studio')?.innerText.slice(0, 300);
              document.querySelector('#hub [data-st=rec]')?.click();
              await w(4500);
              r.during = document.querySelector('#hub [data-st=time]')?.textContent;
              document.querySelector('#hub [data-st=rec]')?.click();
              for (let i = 0; i < 60 && !/Saved/.test(document.querySelector('#hub [data-st=saved]')?.innerText || ''); i++) await w(500);
              r.after = document.querySelector('#hub [data-st=saved]')?.innerText;
            }
            return r;
          })()`
        )
        .catch((e) => ({ error: String(e) }));
      if (SELFTEST_RECORD) {
        const root = recRoot();
        out.files = [];
        const walk = (rel) => {
          for (const f of fs.readdirSync(path.join(root, rel))) {
            const st = fs.statSync(path.join(root, rel, f));
            if (st.isDirectory()) walk(path.join(rel, f));
            else out.files.push(`${path.join(rel, f)} ${st.size} bytes`);
          }
        };
        if (fs.existsSync(root)) walk('');
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
