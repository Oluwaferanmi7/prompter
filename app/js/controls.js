// Shared control UI: the bottom bar, the Aa popover and the full panel (Scripts /
// Display / Connect) plus the script editor. Mounted once per screen and bound to a
// "controller" — either this phone's engine or a remote phone — so both screens
// behave identically.
import * as lib from './library.js';
import * as store from './store.js';
import { fmtTime, wordCount } from './render.js';
import { fileToScript, ACCEPT } from './importer.js';

// Builds nodes in the live document (a <template> fragment is inert and drops
// checkbox state on adoption).
const h = (html) => document.createRange().createContextualFragment(html.trim()).firstElementChild;
const ICON = {
  top: '<svg viewBox="0 0 24 24"><path d="M6 4h12M12 20V8M7 13l5-5 5 5"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M11 6l-6 6 6 6M19 6l-6 6 6 6"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M13 6l6 6-6 6M5 6l6 6-6 6"/></svg>',
  play: '<svg class="i-play" viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z"/></svg><svg class="i-pause" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg><span class="i-count"></span>',
  aa: '<svg viewBox="0 0 24 24"><path d="M3 19l5-14 5 14M5 14h6M15 19l3.5-9 3.5 9M16 16h5"/></svg>',
  mirror: '<svg viewBox="0 0 24 24"><path d="M12 3v18M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>',
  flip: '<svg viewBox="0 0 24 24"><path d="M3 12h18M7 8l5-5 5 5M7 16l5 5 5-5"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

export function mountControls({ root, ctl, hub, toast, onOpenRemote }) {
  // Connected but not allowed to drive (viewer, or another remote has control)?
  // Returns the reason and shows it; null when free to act.
  function locked() {
    const why = ctl.blocked?.();
    if (why) toast(why);
    return why;
  }

  // ------------------------------------------------------------------ bar
  const bar = h(`
    <div class="bar">
      <div class="bar-row">
        <button class="b" data-a="top" aria-label="Back to top">${ICON.top}</button>
        <button class="b" data-a="back" aria-label="Previous paragraph">${ICON.back}</button>
        <button class="b play" data-a="toggle" aria-label="Play">${ICON.play}</button>
        <button class="b" data-a="fwd" aria-label="Next paragraph">${ICON.fwd}</button>
        <button class="b" data-a="aa" aria-label="Text size">${ICON.aa}</button>
        <button class="b mic" data-a="voice" aria-label="Voice glide">${ICON.mic}</button>
      </div>
      <div class="bar-row">
        <button class="b sm" data-a="slower" aria-label="Slower">−</button>
        <span class="speed"><b data-speed>6.0</b><small>speed</small></span>
        <button class="b sm" data-a="faster" aria-label="Faster">+</button>
        <button class="b tog" data-a="mirror" aria-label="Mirror">${ICON.mirror}<span>Mirror</span></button>
        <button class="b tog" data-a="flip" aria-label="Flip">${ICON.flip}<span>Flip</span></button>
        <button class="b" data-a="edit" aria-label="Edit script">${ICON.edit}</button>
        <button class="b" data-a="more" aria-label="More">${ICON.more}</button>
      </div>
    </div>`);
  root.appendChild(bar);
  const playBtn = bar.querySelector('[data-a=toggle]');
  const speedEl = bar.querySelector('[data-speed]');
  const mirrorBtn = bar.querySelector('[data-a=mirror]');
  const flipBtn = bar.querySelector('[data-a=flip]');
  const micBtn = bar.querySelector('[data-a=voice]');

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    e.stopPropagation();
    const a = b.dataset.a;
    if (a !== 'more' && locked()) return;
    if (a === 'toggle') {
      if (!ctl.ready()) return;
      playBtn.classList.toggle('playing', !ctl.state.playing);
      ctl.toggle();
    } else if (a === 'top') ctl.ready() && ctl.top();
    else if (a === 'back') ctl.ready() && ctl.para(-1);
    else if (a === 'fwd') ctl.ready() && ctl.para(1);
    else if (a === 'slower') ctl.ready() && ctl.setSpeed(ctl.settings.speed - 0.5);
    else if (a === 'faster') ctl.ready() && ctl.setSpeed(ctl.settings.speed + 0.5);
    else if (a === 'mirror') ctl.ready() && ctl.setSetting('mirrorX', !ctl.settings.mirrorX);
    else if (a === 'flip') ctl.ready() && ctl.setSetting('mirrorY', !ctl.settings.mirrorY);
    else if (a === 'aa') togglePop();
    else if (a === 'voice') {
      if (!ctl.ready()) return;
      const next = !ctl.state.voice;
      micBtn.classList.toggle('on', next);
      ctl.setVoice(next);
      if (next) toast(ctl.local ? 'Voice glide on — start reading' : 'Voice glide on (mic on the teleprompter phone)');
    }
    else if (a === 'edit') openEditor(ctl.state.scriptId);
    else if (a === 'more') openPanel();
  });

  // ------------------------------------------------------------------ Aa popover
  let pop = null;
  function togglePop() {
    if (pop) return closePop();
    if (locked() || !ctl.ready()) return;
    pop = h('<div class="pop"></div>');
    pop.append(
      slider('Font size', 'fontSize', 20, 160, 2, (v) => v + 'px'),
      slider('Line spacing', 'lineHeight', 1, 2.4, 0.05, (v) => v.toFixed(2)),
      slider('Speed', 'speed', 1, 30, 0.5, (v) => v.toFixed(1))
    );
    pop.addEventListener('click', (e) => e.stopPropagation());
    bar.appendChild(pop);
    bar.querySelector('[data-a=aa]').classList.add('on');
  }
  function closePop() {
    pop?.remove();
    pop = null;
    bar.querySelector('[data-a=aa]').classList.remove('on');
  }
  document.addEventListener('click', () => pop && closePop());

  // ------------------------------------------------------------------ setting widgets
  function fill(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--fill', pct + '%');
  }
  const bound = new Set();
  function setSetting(key, value) {
    if (key === 'speed') ctl.setSpeed(value);
    else ctl.setSetting(key, value);
    syncWidgets();
  }
  function syncWidgets() {
    for (const w of bound) {
      if (w.isConnected) w._sync();
      else bound.delete(w); // widget from a closed panel
    }
  }
  function slider(label, key, min, max, step, fmt, sub) {
    const row = h(`<div class="set-row"><div class="set-label"><span>${label}</span><b></b></div><input type="range" min="${min}" max="${max}" step="${step}">${sub ? `<div class="set-sub">${sub}</div>` : ''}</div>`);
    const input = row.querySelector('input');
    const out = row.querySelector('b');
    row._sync = () => {
      input.value = ctl.settings[key];
      out.textContent = fmt(+ctl.settings[key]);
      fill(input);
    };
    input.addEventListener('input', () => {
      setSetting(key, +input.value);
      out.textContent = fmt(+input.value);
      fill(input);
    });
    bound.add(row);
    row._sync();
    return row;
  }
  function toggleRow(label, key, sub, get = () => ctl.settings[key], set = (v) => setSetting(key, v)) {
    const row = h(`<label class="set-row toggle"><div><div>${label}</div>${sub ? `<div class="set-sub">${sub}</div>` : ''}</div><span class="switch"><input type="checkbox"><span></span></span></label>`);
    const input = row.querySelector('input');
    row._sync = () => {
      input.checked = !!get();
    };
    input.addEventListener('change', () => set(input.checked));
    bound.add(row);
    row._sync();
    return row;
  }
  function segRow(label, key, options, get = () => ctl.settings[key], set = (v) => setSetting(key, v)) {
    const row = h(`<div class="set-row"><div class="set-label"><span>${label}</span></div><div class="seg"></div></div>`);
    const seg = row.querySelector('.seg');
    for (const [val, text] of options) {
      const b = document.createElement('button');
      b.textContent = text;
      b.onclick = () => {
        set(val);
        row._sync();
      };
      b._val = val;
      seg.appendChild(b);
    }
    row._sync = () => {
      const cur = get();
      [...seg.children].forEach((b) => b.classList.toggle('on', b._val === cur));
    };
    bound.add(row);
    row._sync();
    return row;
  }
  function group(title, rows) {
    const g = h(`<section class="set-group-wrap"><div class="set-title">${title}</div><div class="set-group"></div></section>`);
    g.querySelector('.set-group').append(...rows);
    return g;
  }

  // ------------------------------------------------------------------ panel
  const panel = h(`
    <div class="sheet panel" hidden>
      <div class="sheet-brand"><img src="icons/ls-mark-gold.png" alt=""><span><b>LiM</b> Prompter</span></div>
      <header class="sheet-head">
        <h2 class="sheet-title">Scripts</h2>
        <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button>
      </header>
      <nav class="tabs">
        <button class="tab on" data-tab="scripts">Scripts</button>
        <button class="tab" data-tab="display">Display</button>
        <button class="tab" data-tab="connect">Connect</button>
      </nav>
      <div class="sheet-body" data-body></div>
    </div>`);
  root.appendChild(panel);
  const body = panel.querySelector('[data-body]');
  let tab = 'scripts';
  panel.querySelector('[data-close]').onclick = closePanel;
  panel.querySelectorAll('.tab').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

  function openPanel(name = tab) {
    closePop();
    panel.hidden = false;
    showTab(name);
  }
  function closePanel() {
    panel.hidden = true;
  }
  function showTab(name) {
    tab = name;
    panel.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    panel.querySelector('.sheet-title').textContent = { scripts: 'Scripts', display: 'Display', connect: 'Connect' }[name];
    body.replaceChildren();
    if (name === 'scripts') renderScripts();
    else if (name === 'display') renderDisplay();
    else renderConnect();
    body.scrollTop = 0;
  }

  // ---- scripts
  function renderScripts() {
    if (tab !== 'scripts') return;
    body.replaceChildren();
    const head = h(`<div class="panel-head"><span class="muted">${ctl.local ? 'Tap a script to open the teleprompter' : 'Tap a script to send it to the teleprompter'}</span><span class="head-btns"><label class="btn ghost small">Import<input type="file" accept="${ACCEPT}" multiple hidden></label><button class="btn primary small">+ New</button></span></div>`);
    head.querySelector('button').onclick = () => {
      if (locked()) return;
      const s = lib.create();
      ctl.select(s.id);
      openEditor(s.id, true);
    };
    head.querySelector('input[type=file]').onchange = async (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      if (locked()) return;
      const made = [];
      for (const f of files) {
        try {
          const { title, text } = await fileToScript(f);
          made.push(lib.create(title, text));
        } catch (err) {
          toast(err?.message || `Couldn't read ${f.name}`);
        }
      }
      if (!made.length) return;
      if (made.length === 1) {
        ctl.select(made[0].id);
        toast(`Imported “${made[0].title}”`);
        closePanel();
      } else {
        toast(`Imported ${made.length} scripts`);
        renderScripts();
      }
    };
    if (ctl.local && onOpenRemote && ctl.link.targetStatus !== 'idle') {
      const go = h(`<button class="remote-banner"><span><b>Remote</b> for <em></em></span><span>Open ›</span></button>`);
      go.querySelector('em').textContent = ctl.link.targetCode;
      go.onclick = () => {
        closePanel();
        onOpenRemote();
      };
      body.appendChild(go);
    }
    const ul = h('<ul class="script-list"></ul>');
    const activeId = ctl.state.scriptId;
    for (const s of lib.all()) {
      const words = wordCount(s.text);
      const li = h(`<li class="script-item${s.id === activeId ? ' active' : ''}">
        <button class="si-main"><div class="si-title"><span></span>${s.id === activeId ? '<em class="si-badge">Showing</em>' : ''}</div><div class="si-snip"></div><div class="si-meta"></div></button>
        <button class="si-more" aria-label="More">⋯</button></li>`);
      li.querySelector('.si-title span').textContent = s.title || 'Untitled';
      li.querySelector('.si-snip').textContent = s.text.trim().slice(0, 140) || 'Empty';
      li.querySelector('.si-meta').textContent = `${words} words · ~${fmtTime((words / 150) * 60)} · ${new Date(s.updated).toLocaleDateString()}`;
      li.querySelector('.si-main').onclick = () => {
        ctl.select(s.id);
        closePanel();
      };
      li.querySelector('.si-more').onclick = () => scriptActions(s);
      ul.appendChild(li);
    }
    const foot = h(`<div class="panel-foot"><button class="btn ghost small" data-logs>Take logs</button><button class="btn ghost small" data-export>Back up scripts</button><label class="btn ghost small">Restore<input type="file" accept=".json,application/json" hidden></label></div>`);
    foot.querySelector('[data-logs]').onclick = openLogs;
    foot.querySelector('[data-export]').onclick = exportScripts;
    foot.querySelector('input').onchange = importScripts;
    body.append(head, ul, foot);
  }

  function scriptActions(s) {
    const sheet = h(`<div class="modal"><div class="modal-card actions-card"><div class="a-title"></div></div></div>`);
    sheet.querySelector('.a-title').textContent = s.title || 'Untitled';
    const card = sheet.querySelector('.modal-card');
    const add = (label, fn, cls = '') => {
      const b = h(`<button class="${cls}">${label}</button>`);
      b.onclick = () => {
        sheet.remove();
        fn?.();
      };
      card.appendChild(b);
    };
    add('Show on teleprompter', () => {
      ctl.select(s.id);
      closePanel();
    });
    add('Edit', () => openEditor(s.id));
    add('Duplicate', () => {
      lib.create((s.title || 'Untitled') + ' copy', s.text);
      renderScripts();
    });
    add(
      'Delete',
      () => {
        if (!confirm(`Delete “${s.title || 'Untitled'}”? This can't be undone.`)) return;
        lib.remove(s.id);
        if (ctl.state.scriptId === s.id) ctl.select(lib.all()[0].id);
        renderScripts();
      },
      'danger'
    );
    add('Cancel', null, 'cancel');
    sheet.addEventListener('click', (e) => e.target === sheet && sheet.remove());
    root.appendChild(sheet);
  }

  async function exportScripts() {
    const data = JSON.stringify({ app: 'lim-prompter', version: 2, exported: new Date().toISOString(), scripts: lib.all() }, null, 2);
    const name = `prompter-scripts-${new Date().toISOString().slice(0, 10)}.json`;
    await shareFile(new File([data], name, { type: 'application/json' }), 'Prompter scripts');
  }
  // Share sheet (AirDrop, Files, Drive…) where available, else a download.
  async function shareFile(file, title) {
    try {
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title });
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  // ---- take logs (recorded on the teleprompter phone; see takelog.js)
  const pad2 = (n) => String(n).padStart(2, '0');
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  async function openLogs() {
    const sheet = h(`<div class="modal"><div class="modal-card logs-card">
      <div class="a-title">Take logs</div>
      <p class="muted small">One per script opening, ${ctl.local ? 'recorded on this device' : 'recorded on the teleprompter'}: play, pauses, jumps back, speed, voice position and script edits, with times. Drop the file next to the footage for the editor.</p>
      <ul class="log-list"><li class="muted small">Loading…</li></ul>
      <button class="cancel">Close</button></div></div>`);
    const ul = sheet.querySelector('.log-list');
    sheet.querySelector('.cancel').onclick = () => sheet.remove();
    sheet.addEventListener('click', (e) => e.target === sheet && sheet.remove());
    root.appendChild(sheet);
    let list;
    try {
      list = await ctl.logs.list();
    } catch (err) {
      ul.replaceChildren(h(`<li class="muted small"></li>`));
      ul.firstChild.textContent = err?.message || "Couldn't load the logs.";
      return;
    }
    ul.replaceChildren();
    if (!list.length) ul.appendChild(h('<li class="muted small">No take logs yet. One starts on its own when a script is opened and something happens (play, voice glide, a jump or an edit).</li>'));
    for (const meta of list) {
      const d = new Date(meta.started);
      const li = h(`<li><button class="log-item"><div class="si-title"><span></span></div><div class="si-meta"></div><em class="log-go">Share ↗</em></button></li>`);
      li.querySelector('.si-title span').textContent = `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${clock(meta.started)}–${clock(meta.ended)}`;
      li.querySelector('.si-meta').textContent = `${meta.title || 'Untitled'} · ${meta.count} events${meta.closed ? '' : ' · still open'}`;
      const btn = li.querySelector('button');
      const go = li.querySelector('.log-go');
      btn.onclick = async () => {
        if (btn._file) return shareFile(btn._file, 'Take log');
        go.textContent = 'Preparing…';
        try {
          const data = await ctl.logs.get(meta.id);
          if (!data) throw new Error('That log is gone.');
          const slug = (meta.title || 'script').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
          const name = `takelog-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}-${slug}.json`;
          btn._file = new File([JSON.stringify(data)], name, { type: 'application/json' });
          if (ctl.local) {
            go.textContent = 'Share ↗';
            shareFile(btn._file, 'Take log');
          } else go.textContent = 'Ready: tap to share ↗'; // a fetch over the link outlives the tap
        } catch (err) {
          go.textContent = 'Share ↗';
          toast(err?.message || "Couldn't get that log");
        }
      };
      ul.appendChild(li);
    }
  }

  async function importScripts(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const added = lib.importBackup(Array.isArray(data) ? data : data.scripts);
      toast(`Restored ${added} new script${added === 1 ? '' : 's'}`);
      renderScripts();
    } catch {
      toast("That file isn't a Prompter backup");
    }
  }

  // ---- display
  function renderDisplay() {
    if (!ctl.ready()) {
      const p = h('<p class="muted pad"></p>');
      p.textContent = ctl.blocked?.() || 'Connect to a teleprompter first.';
      body.appendChild(p);
      return;
    }
    body.append(
      group('Text', [
        slider('Font size', 'fontSize', 20, 160, 2, (v) => v + 'px'),
        slider('Line spacing', 'lineHeight', 1, 2.4, 0.05, (v) => v.toFixed(2)),
        slider('Side margins', 'margin', 0, 25, 1, (v) => v + '%'),
        segRow('Alignment', 'align', [
          ['left', 'Left'],
          ['center', 'Center'],
        ]),
        segRow('Colors', 'theme', [
          ['white', 'White'],
          ['yellow', 'Yellow'],
          ['light', 'Dark on light'],
        ]),
      ]),
      group('Desview', [
        toggleRow('Mirror text', 'mirrorX', 'Flip left↔right so it reads correctly in the glass'),
        toggleRow('Flip upside down', 'mirrorY', 'Only if your rig shows the text upside down'),
      ]),
      group('Reading line', [
        toggleRow('Show reading line', 'showCue'),
        slider('Position', 'cuePos', 0.1, 0.6, 0.01, (v) => Math.round(v * 100) + '% from top', 'Keep it near the lens so your eyes stay on camera'),
      ]),
      group('Playback', [
        segRow('Countdown before start', 'countdown', [
          [0, 'Off'],
          [3, '3s'],
          [5, '5s'],
          [10, '10s'],
        ]),
        slider('Speed', 'speed', 1, 30, 0.5, (v) => v.toFixed(1)),
      ])
    );
    if (ctl.local) {
      const p = store.getPrefs();
      body.append(
        group('This phone', [
          segRow(
            'Appearance',
            'mode',
            [
              ['auto', 'Auto'],
              ['dark', 'Dark'],
              ['light', 'Light'],
            ],
            () => p.mode,
            (v) => {
              p.mode = v;
              store.savePrefs(p);
              applyMode();
            }
          ),
          toggleRow(
            'Show control bar',
            'showBar',
            'Turn off for a clean screen. Tap the script to bring it back briefly.',
            () => p.showBar,
            (v) => {
              p.showBar = v;
              store.savePrefs(p);
              ctl.onBarPref?.(v);
            }
          ),
        ])
      );
    }
    const reset = h('<button class="btn ghost small center">Reset display to defaults</button>');
    reset.onclick = () => {
      if (!confirm('Reset all display settings?')) return;
      for (const [k, v] of Object.entries(store.DEFAULT_SETTINGS)) if (k !== 'speed') ctl.setSetting(k, v);
      showTab('display');
    };
    body.appendChild(reset);
  }

  // ---- connect
  let connectEl = null;
  function renderConnect() {
    const link = ctl.link;
    const el = h(`
      <div class="connect">
        <section class="set-group-wrap">
          <div class="set-title">This device</div>
          <div class="set-group">
            <div class="code-card">
              <div class="set-sub">Code for controlling this device</div>
              <div class="big-code" data-mycode></div>
              <div class="status-line" data-mystatus></div>
              <button class="btn ghost small" data-newcode>New code</button>
            </div>
            <div class="set-row phones" data-phones hidden></div>
          </div>
        </section>
        <section class="set-group-wrap">
          <div class="set-title">Control another device</div>
          <div class="set-group">
            <div class="code-card">
              <div class="set-sub">Enter the code shown on the other device</div>
              <input class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="ABCD" data-code>
              <div class="status-line" data-status></div>
              <div class="takeover" data-takeover hidden><span data-who></span><button class="btn primary small" data-take>Take over</button></div>
              <div class="row-btns">
                <button class="btn primary" data-connect>Connect</button>
                <button class="btn ghost" data-disconnect hidden>Disconnect</button>
                <button class="btn primary" data-open hidden>Open remote</button>
              </div>
            </div>
          </div>
        </section>
        <p class="muted pad small">Both devices need internet to find each other. After that they reconnect on their own.</p>
      </div>`);
    connectEl = el;
    body.appendChild(el);
    const [mine, other] = el.querySelectorAll('.set-group');
    mine.appendChild(
      segRow('Remotes', 'multi', [[false, 'One at a time'], [true, 'Several']], () => hub.multi, (v) => {
        hub.setMulti(v);
        toast(v ? 'Every remote can control this phone' : 'One remote at a time — others can take over');
      })
    );
    mine.lastChild.appendChild(h('<div class="set-sub">With one at a time, another remote taps Take over to switch. Viewers never control.</div>'));
    other.appendChild(segRow('This device joins as', 'role', [['remote', 'Remote'], ['viewer', 'Viewer']], () => hub.role, (v) => hub.setRole(v)));
    other.lastChild.appendChild(h('<div class="set-sub">Viewer: just the words, full screen, moving live. For the director or a laptop by the camera.</div>'));
    el.querySelector('[data-take]').onclick = () => hub.takeover();
    const input = el.querySelector('[data-code]');
    input.value = link.targetCode || store.getRemoteCode();
    const go = () => {
      const c = input.value.trim().toUpperCase();
      if (!/^[A-HJ-KM-NP-Z2-9]{4}$/.test(c)) {
        el.querySelector('[data-status]').textContent = 'Codes are 4 letters/numbers, like K7QM.';
        return;
      }
      if (c === link.code) {
        el.querySelector('[data-status]').textContent = "That's this phone's own code.";
        return;
      }
      store.setRemoteCode(c);
      link.connect(c);
      input.blur();
      syncConnect();
    };
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (input.value.length === 4 && input.value !== link.targetCode) go();
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    el.querySelector('[data-connect]').onclick = go;
    el.querySelector('[data-disconnect]').onclick = () => {
      link.disconnect();
      store.setRemoteCode('');
      syncConnect();
    };
    el.querySelector('[data-open]').onclick = () => {
      closePanel();
      onOpenRemote?.();
    };
    if (ctl.voiceInfo) {
      const info = ctl.voiceInfo();
      const diag = h(`<section class="set-group-wrap"><div class="set-title">Voice glide diagnostics</div><div class="set-group"><div class="set-row"><div class="set-label"><span>Speech recognition</span><b>${info.supported ? 'available' : 'not available'}</b></div><div class="set-sub">${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 90)}</div></div><div class="set-row"><pre class="diag"></pre></div></div><p class="muted small pad">If voice glide misbehaves, screenshot this and send it to Claude.</p></section>`);
      diag.querySelector('pre').textContent = info.log.length ? info.log.slice(-14).join('\n') : 'No voice activity yet this session.';
      el.appendChild(diag);
    }
    el.querySelector('[data-newcode]').onclick = () => {
      const c = store.newCode();
      store.setMyCode(c);
      link.changeCode(c);
      syncConnect();
    };
    syncConnect();
  }
  function syncConnect() {
    const el = connectEl;
    if (!el?.isConnected) return;
    const link = ctl.link;
    el.querySelector('[data-mycode]').textContent = link.code;
    const my = el.querySelector('[data-mystatus]');
    my.className = 'status-line ' + (link.host === 'ready' ? (link.hasController ? 'ok' : '') : 'bad');
    my.textContent = link.hostDetail || (link.host === 'ready' ? (link.hasController ? 'Connected' : 'Ready — waiting for a remote') : link.host === 'offline' ? 'No internet — retrying…' : 'Getting ready…');
    const st = el.querySelector('[data-status]');
    const ts = link.targetStatus;
    st.className = 'status-line ' + (ts === 'connected' ? 'ok' : ts === 'notfound' ? 'bad' : '');
    st.textContent = { idle: '', connecting: 'Connecting…', notfound: 'Not found. Is the app open on the other phone? Still trying…', connected: `Connected to ${link.targetCode}` }[ts] || '';
    el.querySelector('[data-connect]').hidden = ts !== 'idle';
    el.querySelector('[data-disconnect]').hidden = ts === 'idle';
    el.querySelector('[data-open]').hidden = ts !== 'connected' || !onOpenRemote;
    // Waiting for control?
    const info = hub.info;
    const waiting = ts === 'connected' && hub.role === 'remote' && info && !info.you.control;
    el.querySelector('[data-takeover]').hidden = !waiting;
    if (waiting) el.querySelector('[data-who]').textContent = `${info.seat || 'Another device'} is in control${info.seat && !info.seatOnline ? ' (asleep right now)' : ''}`;
    // Phones connected to this phone's teleprompter.
    const box = el.querySelector('[data-phones]');
    const phones = hub.roster();
    box.hidden = !phones.length;
    box.replaceChildren(h('<div class="set-label"><span>Connected to this device</span></div>'));
    for (const p of phones) {
      const row = h(`<div class="phone-row"><i class="${p.control ? 'on' : ''}"></i><b></b><span></span></div>`);
      row.querySelector('b').textContent = p.code;
      row.querySelector('span').textContent = p.role === 'viewer' ? 'Viewer' : p.control ? 'Remote · in control' : 'Remote · waiting';
      box.appendChild(row);
    }
  }

  // ------------------------------------------------------------------ editor
  const editor = h(`
    <div class="sheet editor" hidden>
      <div class="ed-top">
        <input class="ed-title" placeholder="Script title" maxlength="80">
        <button class="btn primary small" data-done>Done</button>
      </div>
      <textarea placeholder="Paste or type your script…" spellcheck="true"></textarea>
      <div class="ed-foot muted"><span data-stats>0 words</span><span data-live></span></div>
    </div>`);
  root.appendChild(editor);
  const edTitle = editor.querySelector('.ed-title');
  const edText = editor.querySelector('textarea');
  let editingId = null;
  let liveTimer = 0;

  function openEditor(id, focusTitle) {
    if (locked()) return;
    const s = lib.get(id);
    if (!s) return;
    editingId = id;
    edTitle.value = s.title;
    edText.value = s.text;
    edStats();
    editor.hidden = false;
    fitEditor();
    // Start at the line the speaker is on, not the top.
    const here = id === ctl.state.scriptId ? ctl.state.a?.p || 0 : 0;
    const lines = edText.value.split('\n');
    let off = 0;
    for (let i = 0; i < Math.min(here, lines.length); i++) off += lines[i].length + 1;
    setTimeout(() => {
      if (focusTitle) return edTitle.select();
      edText.focus({ preventScroll: true });
      edText.setSelectionRange(off, off);
      edText.scrollTop = Math.max(0, caretY(edText, off) - edText.clientHeight * 0.25);
    }, 50);
  }
  // Pixel offset of a character position inside a textarea (via an invisible copy).
  function caretY(ta, off) {
    const cs = getComputedStyle(ta);
    const m = document.createElement('div');
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'tabSize']) m.style[k] = cs[k];
    Object.assign(m.style, { position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0', boxSizing: 'border-box', width: ta.clientWidth + 'px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
    m.textContent = ta.value.slice(0, off);
    const mark = document.createElement('span');
    mark.textContent = '\u200b';
    m.appendChild(mark);
    document.body.appendChild(m);
    const y = mark.offsetTop;
    m.remove();
    return y;
  }
  function edStats() {
    const w = wordCount(edText.value);
    editor.querySelector('[data-stats]').textContent = `${w} words · ~${fmtTime((w / 150) * 60)} read`;
    const live = editor.querySelector('[data-live]');
    const showing = editingId === ctl.state.scriptId;
    live.textContent = showing ? (ctl.local ? '● Live on screen' : ctl.ready() ? '● Live on teleprompter' : 'Not connected') : '';
    live.className = showing && (ctl.local || ctl.ready()) ? 'on' : '';
  }
  function onEdit() {
    if (!editingId) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => lib.upsert({ id: editingId, title: edTitle.value, text: edText.value }), 150);
    edStats();
  }
  edTitle.addEventListener('input', onEdit);
  edText.addEventListener('input', onEdit);
  editor.querySelector('[data-done]').onclick = () => {
    clearTimeout(liveTimer);
    let title = edTitle.value;
    if (!title.trim()) title = edText.value.trim().split('\n')[0].slice(0, 40) || 'Untitled script';
    lib.upsert({ id: editingId, title, text: edText.value });
    editingId = null;
    edTitle.blur();
    edText.blur();
    editor.hidden = true;
    if (!panel.hidden && tab === 'scripts') renderScripts();
  };
  // iOS doesn't shrink the layout for the keyboard; size the editor to the visible area.
  function fitEditor() {
    if (editor.hidden || !window.visualViewport) return;
    editor.style.height = visualViewport.height + 'px';
    editor.style.top = visualViewport.offsetTop + 'px';
    editor.style.bottom = 'auto';
  }
  window.visualViewport?.addEventListener('resize', fitEditor);
  window.visualViewport?.addEventListener('scroll', fitEditor);

  // ------------------------------------------------------------------ refresh
  function update() {
    const s = ctl.state;
    const st = ctl.settings;
    playBtn.classList.toggle('playing', !!s.playing);
    playBtn.classList.toggle('counting', !!s.counting);
    playBtn.querySelector('.i-count').textContent = s.counting || '';
    speedEl.textContent = (+st.speed || 0).toFixed(1);
    mirrorBtn.classList.toggle('on', !!st.mirrorX);
    flipBtn.classList.toggle('on', !!st.mirrorY);
    micBtn.classList.toggle('on', !!s.voice);
    bar.classList.toggle('disabled', !ctl.ready());
    syncWidgets();
    if (!editor.hidden) edStats();
    if (!panel.hidden && tab === 'connect') syncConnect();
  }

  return { bar, panel, editor, openPanel, closePanel, openEditor, update, syncConnect, closePop, get panelOpen() { return !panel.hidden; } };
}

// Light / dark / auto for the app chrome.
export function applyMode() {
  const p = store.getPrefs();
  document.documentElement.dataset.theme = p.mode === 'auto' ? '' : p.mode;
}
