# LiM Prompter

A free teleprompter web app (PWA) with phone-to-phone remote control, built for a Desview rig.

**Live:** https://oluwaferanmi7.github.io/prompter/ (`/prompter/voice/` serves the same build for phones that installed the old test link)

- Every phone is a teleprompter (text mirrored for the glass, control bar, script library, editor, display settings).
- Any phone can control another: ⋯ → Connect, enter the other phone's 4-character code. Play/pause, speed, jump by paragraph, drag the preview to move the prompter to the exact same spot, font/spacing/mirror/flip, live script editing. Switch between "my teleprompter" and "remote" without disconnecting.
- Losing the link never touches the script on screen; phones reconnect on their own.
- Script libraries merge between paired phones. No accounts, no backend: phones talk directly over WebRTC ([PeerJS](https://peerjs.com) free signalling + TURN).
- Voice glide: scroll follows your reading via on-device speech recognition, tolerant of ad-libs.
- Import scripts from files on the phone (.txt, .md, .docx).

## Install on iPhone

Open the link in **Safari** → Share → **Add to Home Screen**. Do it on both phones.

## Develop

No build step. `node tools/serve.mjs` then open http://localhost:5173, or http://localhost:5173/dev.html for a side-by-side two-phone test bench. `node tools/test-voice.mjs` runs the voice matcher tests.

Pushing `main` deploys `app/` to the site root and to `/voice/`. Bump `VERSION` in `app/sw.js` when you ship so installed apps pick up the update.
