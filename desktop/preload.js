// What the desktop app offers the Sapphire web app: knowing it's on the desktop (that shows
// the Hub), writing recordings into the recordings folder, and making them playable after
// Stop (FFmpeg, inside the take folder only). Nothing else: no general file access, no
// shell. main.js also checks every call comes from the app's own origin.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('sapphireDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: '0.3.0',
  rec: {
    root: call('rec:root'), // → folder path (for showing)
    chooseRoot: call('rec:chooseRoot'), // → new folder path
    begin: call('rec:begin'), // (takeName) → { token, folder }
    open: call('rec:open'), // (token, fileName) → file id
    write: call('rec:write'), // (fileId, ArrayBuffer)
    close: call('rec:close'), // (fileId) → size in bytes
    writeText: call('rec:writeText'), // (token, fileName, text)
    reveal: call('rec:reveal'), // (token?) → opens the folder in Explorer
    canFinish: call('rec:canFinish'), // → true when FFmpeg is there
    finish: call('rec:finish'), // (token, [{ file, kind }], { mp3, durationMs }) → results
    onProgress: (cb) => ipcRenderer.on('rec:progress', (_e, p) => cb(p)), // finish progress
  },
});
