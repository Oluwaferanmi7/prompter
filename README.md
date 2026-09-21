# Prompter

A free teleprompter web app (PWA) with phone-to-phone remote control, built for a Desview rig.

**Live:** https://oluwaferanmi7.github.io/prompter/

- One phone sits in the Desview as the **Teleprompter** (text mirrored for the glass).
- Another phone is the **Remote**: play/pause, speed, jump by paragraph, drag the preview to move the prompter to the exact same spot, font size, line spacing, margins, mirroring, and a saved script library with live editing.
- The phones pair with a 4-character code and talk directly over WebRTC ([PeerJS](https://peerjs.com), free public signalling + TURN). No accounts, no backend. Scripts stay in the remote phone's local storage.

## Install on iPhone

Open the link in **Safari** → Share → **Add to Home Screen**. Do it on both phones.

## Develop

No build step. `node tools/serve.mjs` then open http://localhost:5173 — or http://localhost:5173/dev.html for a side-by-side two-phone test bench.

Pushing to `main` deploys `app/` to GitHub Pages. Bump `VERSION` in `app/sw.js` when you ship so installed apps pick up the update.
