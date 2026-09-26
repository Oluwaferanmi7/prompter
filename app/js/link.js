// Device-to-device link over WebRTC (PeerJS; free public signalling + TURN, no account).
//
// Every phone is a teleprompter and registers under its own code so any other phone can
// dial it. Any number of phones can dial the same teleprompter (as remotes or viewers);
// each inbound connection is keyed by the dialling phone's code. Both directions
// self-heal: iOS drops sockets whenever the screen locks or the app is backgrounded, so
// everything assumes connections die and quietly reconnects. Losing the link never
// changes what the teleprompter is showing.

const PREFIX = 'fera-tp-v2-';
const Peer = () => window.Peer;
const peerOptions = () => ({ debug: 1, pingInterval: 4000 });

export class Link {
  constructor({ code, onMessage, onStatus, onControllerChange, onOpen }) {
    this.code = code;
    this.onMessage = onMessage; // (msg, from: 'controller' | 'target', code of the controller)
    this.onStatus = onStatus; // ({ host, target })
    this.onControllerChange = onControllerChange; // (attached: boolean, code)
    this.onOpen = onOpen; // outbound connection opened
    this.peer = null;
    this.host = 'starting'; // starting | ready | offline
    this.hostDetail = '';
    this.controllers = new Map(); // code -> { conn, rx } — phones connected to us
    this.targetCode = '';
    this.target = null; // outbound connection (we control someone)
    this.targetStatus = 'idle'; // idle | connecting | notfound | connected
    this.targetRx = 0;
    this.retryTimer = null;
    this.dialTimer = null;
    this.dialTimeout = null;
    this.failCount = 0;
    this.rtt = null;
    setInterval(() => this._tick(), 2000);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this._revive());
    window.addEventListener('online', () => this._revive());
    this._build();
  }

  _status() {
    this.onStatus?.({ host: this.host, hostDetail: this.hostDetail, target: this.targetStatus, controllers: this.controllerCount });
  }

  // ------------------------------------------------------------- peer (our identity)
  _build() {
    clearTimeout(this.retryTimer);
    if (this.peer && !this.peer.destroyed) this.peer.destroy();
    this._dropTarget();
    if (!Peer()) {
      this.host = 'offline';
      this.hostDetail = 'Connection library failed to load';
      this._status();
      this.retryTimer = setTimeout(() => this._build(), 4000);
      return;
    }
    this.host = 'starting';
    this.hostDetail = '';
    this._status();
    const peer = new (Peer())(PREFIX + this.code, peerOptions());
    this.peer = peer;
    peer.on('open', () => {
      if (peer !== this.peer) return;
      this.failCount = 0;
      this.host = 'ready';
      this.hostDetail = '';
      this._status();
      if (this.targetCode) this._dial();
    });
    peer.on('connection', (c) => this._accept(c));
    peer.on('disconnected', () => {
      if (peer !== this.peer || peer.destroyed) return;
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
        // Our previous registration hasn't expired on the server yet (after a reload).
        this.failCount++;
        this.host = 'starting';
        this.hostDetail = this.failCount > 3 ? 'Code still held by the server — retrying…' : '';
        this._status();
        this.retryTimer = setTimeout(() => this._build(), 2500);
      } else if (type === 'peer-unavailable') {
        this._dropTarget();
        this.targetStatus = 'notfound';
        this._status();
        this._retryDial(2500);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(type)) {
        this.host = 'offline';
        this.hostDetail = 'No internet — retrying…';
        this._status();
        this.retryTimer = setTimeout(() => this._build(), 3000);
      }
    });
  }

  _revive() {
    if (!this.peer || this.peer.destroyed) return this._build();
    if (this.peer.disconnected) {
      try {
        this.peer.reconnect();
      } catch {
        this._build();
      }
    }
    if (this.targetCode && !(this.target?.open && Date.now() - this.targetRx < 5000)) this._retryDial(300);
  }

  changeCode(code) {
    this.code = code;
    for (const code of [...this.controllers.keys()]) this._dropController(code);
    this._build();
  }

  // ------------------------------------------------------------- inbound (we are controlled)
  _accept(c) {
    const code = String(c.peer || '').replace(PREFIX, '') || c.connectionId;
    const prev = this.controllers.get(code);
    if (prev && prev.conn !== c) {
      // Same phone redialled (it reloaded or lost the socket): the new connection wins.
      prev.conn.removeAllListeners?.();
      try {
        prev.conn.close();
      } catch {}
    }
    const entry = { conn: c, rx: Date.now() };
    this.controllers.set(code, entry);
    const mine = () => this.controllers.get(code) === entry;
    c.on('open', () => {
      if (!mine()) return;
      entry.rx = Date.now();
      this.onControllerChange?.(true, code);
      this._status();
    });
    c.on('data', (msg) => {
      if (!mine()) return;
      entry.rx = Date.now();
      if (msg?.t === 'ping') return this.sendTo(code, { t: 'pong', ts: msg.ts });
      this.onMessage?.(msg, 'controller', code);
    });
    const gone = () => {
      if (!mine()) return;
      this.controllers.delete(code);
      this.onControllerChange?.(false, code);
      this._status();
    };
    c.on('close', gone);
    c.on('error', gone);
  }

  _dropController(code) {
    const e = this.controllers.get(code);
    if (!e) return;
    this.controllers.delete(code);
    try {
      e.conn.close();
    } catch {}
    this.onControllerChange?.(false, code);
    this._status();
  }

  // Codes of phones currently connected to us.
  get controllerCodes() {
    return [...this.controllers].filter(([, e]) => e.conn.open).map(([code]) => code);
  }
  get controllerCount() {
    return this.controllerCodes.length;
  }
  get hasController() {
    return this.controllerCount > 0;
  }

  sendTo(code, msg) {
    const c = this.controllers.get(code)?.conn;
    if (c?.open) {
      try {
        c.send(msg);
      } catch {}
    }
  }

  // To every connected phone (optionally except one).
  sendToController(msg, except) {
    for (const [code, e] of this.controllers) {
      if (code === except || !e.conn.open) continue;
      try {
        e.conn.send(msg);
      } catch {}
    }
  }

  // ------------------------------------------------------------- outbound (we control)
  connect(code) {
    this.targetCode = code;
    this._dropTarget();
    this.targetStatus = 'connecting';
    this._status();
    if (this.peer?.open) this._dial();
    else if (!this.peer || this.peer.destroyed) this._build();
  }

  disconnect() {
    this.targetCode = '';
    clearTimeout(this.dialTimer);
    this._dropTarget();
    this.targetStatus = 'idle';
    this._status();
  }

  _dial() {
    if (!this.targetCode || !this.peer?.open) return;
    clearTimeout(this.dialTimer);
    this._dropTarget();
    if (this.targetStatus !== 'notfound') {
      this.targetStatus = 'connecting';
      this._status();
    }
    const c = this.peer.connect(PREFIX + this.targetCode, { reliable: true });
    this.target = c;
    this.dialTimeout = setTimeout(() => {
      if (this.target === c && !c.open) {
        this._dropTarget();
        this._retryDial(500);
      }
    }, 9000);
    c.on('open', () => {
      if (this.target !== c) return;
      clearTimeout(this.dialTimeout);
      this.targetRx = Date.now();
      this.targetStatus = 'connected';
      this._status();
      this.onOpen?.();
    });
    c.on('data', (msg) => {
      if (this.target !== c) return;
      this.targetRx = Date.now();
      if (msg?.t === 'pong') {
        this.rtt = Date.now() - msg.ts;
        return;
      }
      this.onMessage?.(msg, 'target');
    });
    const gone = () => {
      if (this.target !== c) return;
      this.target = null;
      if (this.targetCode) {
        this.targetStatus = 'connecting';
        this._status();
        this._retryDial(1200);
      }
    };
    c.on('close', gone);
    c.on('error', gone);
  }

  _retryDial(ms) {
    clearTimeout(this.dialTimer);
    if (!this.targetCode) return;
    this.dialTimer = setTimeout(() => {
      if (!this.peer || this.peer.destroyed) this._build();
      else if (this.peer.disconnected) this._revive();
      else this._dial();
    }, ms);
  }

  _dropTarget() {
    clearTimeout(this.dialTimeout);
    const c = this.target;
    this.target = null;
    if (c) {
      try {
        c.close();
      } catch {}
    }
  }

  get connected() {
    return !!this.target?.open;
  }

  send(msg) {
    if (this.target?.open) {
      try {
        this.target.send(msg);
      } catch {}
    }
  }

  // ------------------------------------------------------------- housekeeping
  _tick() {
    if (this.target?.open) {
      this.send({ t: 'ping', ts: Date.now() });
      if (Date.now() - this.targetRx > 7000) {
        this._dropTarget();
        this.targetStatus = 'connecting';
        this._status();
        this._retryDial(200);
      }
    }
    for (const [code, e] of this.controllers) {
      // A phone went quiet (locked, walked away). Drop it; it will redial.
      if (Date.now() - e.rx > 9000) this._dropController(code);
    }
  }
}
