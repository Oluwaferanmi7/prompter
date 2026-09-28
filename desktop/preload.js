// What the desktop app offers the Sapphire web app. Kept tiny on purpose: stage 2 only
// needs the app to know it's running on the desktop (that shows the Hub). Recording with
// FFmpeg (stage 3) will add a few narrow functions here, never general file or shell access.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('sapphireDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: '0.1.0',
});
