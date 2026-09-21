// Device-to-device link over WebRTC (PeerJS; free public signalling + TURN, no account).
// The prompter registers as a well-known peer id derived from its 4-char code; the
// remote dials it. Both sides self-heal: iOS drops sockets whenever the screen locks or
// the app is backgrounded, so everything assumes connections die and reconnects.

const PREFIX = 'fera-tp-v1-';
const Peer = () => window.Peer;

function peerOptions() {
  return { debug: 1, pingInterval: 4000 };
}

// ---------------------------------------------------------------- prompter side
export class PrompterHost {
  constructor({ onMessage, onStatus }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.peer = null;
    this.conn = null;
    this.code = null;
    this.status = 'idle';
    this.lastRx = 0;
    this.retryTimer = null;
    this.failCount = 0;
    this._watch = setInterval(() => this._watchdog(), 2000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._revive();
    });
    window.addEventListener('online', () => this._revive());
  }

  _set(status, detail) {
    this.status = status;
    this.onStatus?.(status, detail);
  }

  start(code) {
    this.code = code;
    this._build();
  }

  _build() {
    clearTimeout(this.retryTimer);
    if (this.peer && !this.peer.destroyed) this.peer.destroy();
    if (!Peer()) {
      this._set('offline', 'Connection library failed to load');
      this.retryTimer = setTimeout(() => this._build(), 4000);
      return;
    }
    this._set('starting');
    const peer = new (Peer())(PREFIX + this.code, peerOptions());
    this.peer = peer;
    peer.on('open', () => {
      this.failCount = 0;
      this._set(this.conn?.open ? 'connected' : 'waiting');
    });
    peer.on('connection', (c) => this._accept(c));
    peer.on('disconnected', () => {
      if (peer !== this.peer || peer.destroyed) return;
      // Lost the signalling server; existing data connection may still be alive.
      setTimeout(() => {
        if (peer === this.peer && !peer.destroyed && peer.disconnected) {
          try {
            peer.reconnect();
          } catch {
            this._build();
          }
        }
      }, 1000);
    });
    peer.on('error', (err) => {
      if (peer !== this.peer) return;
      const type = err?.type;
      if (type === 'unavailable-id') {
        // Our old registration hasn't expired on the server yet (typical after a reload).
        this.failCount++;
        this._set('starting', this.failCount > 3 ? 'Code still held by the server — retrying…' : '');
        this.retryTimer = setTimeout(() => this._build(), 2500);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(type)) {
        this._set('offline', 'No internet — retrying…');
        this.retryTimer = setTimeout(() => this._build(), 3000);
      }
    });
  }

  _accept(c) {
    if (this.conn && this.conn !== c) {
      try {
        this.conn.close();
      } catch {}
    }
    this.conn = c;
    c.on('open', () => {
      if (this.conn !== c) return;
      this.lastRx = Date.now();
      this._set('connected');
    });
    c.on('data', (msg) => {
      if (this.conn !== c) return;
      this.lastRx = Date.now();
      if (this.status !== 'connected') this._set('connected');
      if (msg?.t === 'ping') {
        this.send({ t: 'pong', ts: msg.ts });
        return;
      }
      this.onMessage?.(msg);
    });
    const gone = () => {
      if (this.conn !== c) return;
      this.conn = null;
      this._set(this.peer && !this.peer.destroyed && !this.peer.disconnected ? 'waiting' : 'starting');
    };
    c.on('close', gone);
    c.on('error', gone);
  }

  _watchdog() {
    if (this.conn && this.status === 'connected' && Date.now() - this.lastRx > 9000) {
      // Remote went quiet (locked phone, walked away). Drop it; it will redial.
      try {
        this.conn.close();
      } catch {}
      this.conn = null;
      this._set('waiting');
    }
  }

  _revive() {
    if (!this.code) return;
    if (!this.peer || this.peer.destroyed) this._build();
    else if (this.peer.disconnected) {
      try {
        this.peer.reconnect();
      } catch {
        this._build();
      }
    }
  }

  get connected() {
    return !!this.conn?.open;
  }

  send(msg) {
    if (this.conn?.open) {
      try {
        this.conn.send(msg);
      } catch {}
    }
  }

  changeCode(code) {
    this.code = code;
    if (this.conn) {
      try {
        this.conn.close();
      } catch {}
      this.conn = null;
    }
    this._build();
  }
}

// ---------------------------------------------------------------- remote side
export class RemoteClient {
  constructor({ onMessage, onStatus, onOpen }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onOpen = onOpen;
    this.peer = null;
    this.conn = null;
    this.code = '';
    this.status = 'idle';
    this.lastRx = 0;
    this.timer = null;
    this.dialTimeout = null;
    this.rtt = null;
    setInterval(() => this._tick(), 2000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.code) this._revive();
    });
    window.addEventListener('online', () => this.code && this._revive());
  }

  _set(status, detail) {
    this.status = status;
    this.onStatus?.(status, detail);
  }

  connect(code) {
    this.code = code;
    this._closeConn();
    this._ensurePeer(() => this._dial());
  }

  disconnect() {
    this.code = '';
    clearTimeout(this.timer);
    this._closeConn();
    this._set('idle');
  }

  _ensurePeer(then) {
    if (this.peer && !this.peer.destroyed && !this.peer.disconnected && this.peer.open) return then();
    if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
      try {
        this.peer.reconnect();
        this.peer.once('open', then);
        return;
      } catch {}
    }
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {}
    }
    if (!Peer()) {
      this._set('offline', 'Connection library failed to load');
      this._retry(4000);
      return;
    }
    this._set('connecting');
    const peer = new (Peer())(peerOptions());
    this.peer = peer;
    peer.on('open', () => {
      if (peer === this.peer) then();
    });
    peer.on('disconnected', () => {
      if (peer !== this.peer || peer.destroyed) return;
      setTimeout(() => {
        if (peer === this.peer && !peer.destroyed && peer.disconnected) {
          try {
            peer.reconnect();
          } catch {}
        }
      }, 1000);
    });
    peer.on('error', (err) => {
      if (peer !== this.peer) return;
      const type = err?.type;
      if (type === 'peer-unavailable') {
        this._closeConn();
        this._set('notfound');
        this._retry(2500);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) {
        this._set('offline', 'No internet — retrying…');
        try {
          peer.destroy();
        } catch {}
        this._retry(3000);
      } else {
        this._retry(3000);
      }
    });
  }

  _dial() {
    if (!this.code) return;
    clearTimeout(this.timer);
    this._closeConn();
    if (this.status !== 'notfound') this._set('connecting');
    const c = this.peer.connect(PREFIX + this.code, { reliable: true });
    this.conn = c;
    clearTimeout(this.dialTimeout);
    this.dialTimeout = setTimeout(() => {
      if (this.conn === c && !c.open) {
        this._closeConn();
        this._retry(500);
      }
    }, 9000);
    c.on('open', () => {
      if (this.conn !== c) return;
      clearTimeout(this.dialTimeout);
      this.lastRx = Date.now();
      this._set('connected');
      this.onOpen?.();
    });
    c.on('data', (msg) => {
      if (this.conn !== c) return;
      this.lastRx = Date.now();
      if (msg?.t === 'pong') {
        this.rtt = Date.now() - msg.ts;
        return;
      }
      this.onMessage?.(msg);
    });
    const gone = () => {
      if (this.conn !== c) return;
      this.conn = null;
      if (this.code) {
        this._set('connecting');
        this._retry(1200);
      }
    };
    c.on('close', gone);
    c.on('error', gone);
  }

  _retry(ms) {
    clearTimeout(this.timer);
    if (!this.code) return;
    this.timer = setTimeout(() => this._ensurePeer(() => this._dial()), ms);
  }

  _closeConn() {
    clearTimeout(this.dialTimeout);
    const c = this.conn;
    this.conn = null;
    if (c) {
      try {
        c.close();
      } catch {}
    }
  }

  _tick() {
    if (!this.conn?.open) return;
    this.send({ t: 'ping', ts: Date.now() });
    if (Date.now() - this.lastRx > 7000) {
      this._closeConn();
      this._set('connecting');
      this._retry(200);
    }
  }

  _revive() {
    if (this.conn?.open && Date.now() - this.lastRx < 5000) return;
    this._closeConn();
    this._ensurePeer(() => this._dial());
  }

  get connected() {
    return !!this.conn?.open;
  }

  send(msg) {
    if (this.conn?.open) {
      try {
        this.conn.send(msg);
      } catch {}
    }
  }
}
