// Remote control (the phone in your hand). Owns the script library + display settings,
// pushes them to the prompter, and mirrors the prompter's position in a live preview
// you can drag to move the teleprompter to the exact same spot.
import { RemoteClient } from './link.js';
import { renderScript, measure, anchorAt, yForAnchor, fmtTime, wordCount, THEMES } from './render.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const CODE_RE = /^[A-HJ-KM-NP-Z2-9]{4}$/;

export function createRemote({ goHome, toast }) {
  const view = $('remote');
  const preview = $('r-preview');
  const pv = $('r-content');
  const padTop = $('r-padtop');
  const padBot = $('r-padbot');
  const pvCue = $('r-cue');
  const playBtn = $('r-play');
  const speedIn = $('r-speed');
  const pill = $('r-pill');

  let scripts = store.getScripts();
  let activeId = store.getActiveId();
  if (!scripts.some((s) => s.id === activeId)) activeId = scripts[0].id;
  let settings = store.getSettings();
  let active = false;
  let tab = 'live';

  // prompter-reported state
  let ps = { playing: false, counting: 0, speed: settings.speed, a: { p: 0, f: 0 }, progress: 0, remain: NaN, scriptId: null };

  const link = new RemoteClient({ onMessage: handle, onStatus: onLinkStatus, onOpen: onOpen });

  const current = () => scripts.find((s) => s.id === activeId) || scripts[0];

  // ================================================================ preview
  let m = { tops: [], heights: [], total: 0, count: 0 };
  let displayY = 0; // what the preview shows
  let targetY = 0; // where the prompter is (predicted between updates)
  let lastProg = -1; // last scrollTop we set ourselves
  let touching = false;
  let lastUser = 0;
  let lastSeekSent = 0;
  let pastIdx = -1;
  let raf = 0;
  let lastT = 0;

  const pvLineH = () => 21 * settings.lineHeight;
  const userActive = () => touching || performance.now() - lastUser < 700;

  function layoutPreview(keep = true) {
    const a = keep ? anchorAt(displayY, m) : { p: 0, f: 0 };
    const h = preview.clientHeight;
    if (!h) return;
    padTop.style.height = Math.round(h * settings.cuePos) + 'px';
    padBot.style.height = Math.round(h * (1 - settings.cuePos)) + 'px';
    pvCue.style.top = Math.round(h * settings.cuePos) + 'px';
    pv.style.lineHeight = settings.lineHeight;
    pv.style.textAlign = settings.align;
    m = measure(pv);
    displayY = targetY = yForAnchor(a, m);
    setScroll(displayY);
    pastIdx = -1;
  }

  function renderPreview(resetPos) {
    const s = current();
    renderScript(pv, s.text.trim() ? s.text : 'This script is empty — tap the pencil to write it.');
    $('r-title').textContent = s.title || 'Untitled';
    layoutPreview(!resetPos);
  }

  function setScroll(v) {
    preview.scrollTop = v;
    lastProg = preview.scrollTop;
  }

  preview.addEventListener('touchstart', () => (touching = true), { passive: true });
  const touchEnd = () => {
    touching = false;
    lastUser = performance.now();
  };
  preview.addEventListener('touchend', touchEnd, { passive: true });
  preview.addEventListener('touchcancel', touchEnd, { passive: true });
  preview.addEventListener('wheel', () => (lastUser = performance.now()), { passive: true });
  let mouseDrag = null; // desktop: drag the preview with a mouse, like a touch
  preview.addEventListener('mousedown', (e) => {
    mouseDrag = { y: e.clientY, top: preview.scrollTop, moved: false };
    touching = true;
  });
  window.addEventListener('mousemove', (e) => {
    if (!mouseDrag) return;
    const dy = e.clientY - mouseDrag.y;
    if (Math.abs(dy) > 4) mouseDrag.moved = true;
    if (mouseDrag.moved) preview.scrollTop = mouseDrag.top - dy;
  });
  window.addEventListener('mouseup', () => {
    if (!mouseDrag) return;
    preview.dataset.dragged = mouseDrag.moved ? '1' : '';
    mouseDrag = null;
    touchEnd();
  });

  preview.addEventListener(
    'scroll',
    () => {
      const st = preview.scrollTop;
      if (Math.abs(st - lastProg) < 2) return; // our own update
      lastUser = performance.now();
      displayY = targetY = st;
      lastProg = st;
      const now = performance.now();
      if (now - lastSeekSent > 33) {
        lastSeekSent = now;
        link.send({ t: 'seek', a: anchorAt(st, m), drag: true });
      }
      clearTimeout(preview._settle);
      preview._settle = setTimeout(() => link.send({ t: 'seek', a: anchorAt(preview.scrollTop, m), drag: true }), 120);
    },
    { passive: true }
  );

  // Tap a paragraph to jump there.
  pv.addEventListener('click', (e) => {
    if (preview.dataset.dragged) {
      preview.dataset.dragged = '';
      return;
    }
    const para = e.target.closest('.para');
    if (!para || para.classList.contains('blank')) return;
    const a = { p: +para.dataset.i, f: 0 };
    link.send({ t: 'seek', a, drag: false });
    targetY = yForAnchor(a, m);
    lastUser = 0;
    touching = false;
  });

  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - (lastT || t)) / 1000);
    lastT = t;
    if (userActive()) {
      targetY = displayY = preview.scrollTop;
    } else {
      if (ps.playing && link.connected) targetY += ps.speed * 0.1 * pvLineH() * dt;
      targetY = Math.max(0, Math.min(m.total, targetY));
      const k = 1 - Math.exp(-dt * 10);
      displayY += (targetY - displayY) * k;
      if (Math.abs(targetY - displayY) < 0.3) displayY = targetY;
      if (Math.abs(preview.scrollTop - displayY) >= 0.5) setScroll(displayY);
    }
    const p = anchorAt(displayY + 1, m).p;
    if (p !== pastIdx) {
      const kids = pv.children;
      for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('past', i < p);
      pastIdx = p;
    }
  }

  // ================================================================ link
  function onOpen() {
    link.send({ t: 'hello' });
    pushLoad();
  }
  function pushLoad() {
    const s = current();
    link.send({ t: 'load', script: { id: s.id, title: s.title, text: s.text }, settings });
  }

  function handle(msg) {
    if (msg?.t !== 'state') return;
    ps = msg;
    if (msg.scriptId && msg.scriptId !== activeId) {
      // Prompter is showing something else (e.g. reconnected after we switched) — resend.
      pushLoad();
      return;
    }
    if (!userActive()) targetY = yForAnchor(msg.a, m);
    if (!speedDragging && msg.speed !== settings.speed) {
      settings.speed = msg.speed;
      store.saveSettings(settings);
      syncSpeedUI();
    }
    playBtn.classList.toggle('playing', !!msg.playing);
    playBtn.classList.toggle('counting', !!msg.counting);
    $('r-count').textContent = msg.counting || '';
    $('r-progress').style.width = Math.round((msg.progress || 0) * 1000) / 10 + '%';
    $('r-left').textContent = fmtTime(msg.remain);
  }

  const PILL = {
    idle: ['Pair', ''],
    connecting: ['Connecting…', 'wait'],
    notfound: ['Not found', 'bad'],
    offline: ['Offline', 'bad'],
    connected: ['', 'ok'],
  };
  let wasConnected = false;
  function onLinkStatus(status, detail) {
    renderStatus(status, detail);
    if (status === 'connected') {
      if (!wasConnected) toast('Connected to teleprompter');
      wasConnected = true;
      if (!$('pair').hidden) setTimeout(() => ($('pair').hidden = true), 500);
    } else {
      if (wasConnected && status !== 'idle') toast('Lost connection — reconnecting…');
      wasConnected = false;
      playBtn.classList.remove('playing', 'counting');
      ps.playing = false;
    }
  }
  function renderStatus(status, detail) {
    const [label, cls] = PILL[status] || [status, ''];
    pill.className = 'pill ' + cls;
    $('r-pill-text').textContent = status === 'connected' ? link.code : label;
    const ps2 = $('pair-status');
    ps2.className = 'pair-status' + (cls === 'ok' ? ' ok' : cls === 'bad' ? ' bad' : '');
    ps2.textContent =
      detail ||
      {
        connecting: 'Connecting…',
        notfound: 'Teleprompter not found. Is it open on the other phone? Still trying…',
        offline: 'No internet. Still trying…',
        connected: 'Connected!',
        idle: '',
      }[status] ||
      '';
  }

  function requireLink() {
    if (link.connected) return true;
    openPair();
    return false;
  }

  // ================================================================ transport
  playBtn.onclick = () => {
    if (!requireLink()) return;
    // optimistic
    playBtn.classList.toggle('playing', !(ps.playing || ps.counting));
    link.send({ t: 'toggle' });
  };
  $('r-back').onclick = () => requireLink() && link.send({ t: 'para', dir: -1 });
  $('r-fwd').onclick = () => requireLink() && link.send({ t: 'para', dir: 1 });
  $('r-top').onclick = () => {
    if (!requireLink()) return;
    link.send({ t: 'top' });
    targetY = 0;
  };

  let speedDragging = false;
  function syncSpeedUI() {
    speedIn.value = settings.speed;
    $('r-speed-val').textContent = settings.speed.toFixed(1);
    fill(speedIn);
  }
  function setSpeed(v) {
    settings.speed = Math.max(1, Math.min(30, Math.round(v * 2) / 2));
    store.saveSettings(settings);
    syncSpeedUI();
    link.send({ t: 'speed', v: settings.speed });
  }
  speedIn.addEventListener('input', () => {
    speedDragging = true;
    setSpeed(+speedIn.value);
  });
  speedIn.addEventListener('change', () => (speedDragging = false));
  speedIn.addEventListener('pointerup', () => (speedDragging = false));
  $('r-slower').onclick = () => setSpeed(settings.speed - 0.5);
  $('r-faster').onclick = () => setSpeed(settings.speed + 0.5);

  // quick font popover
  let pop = null;
  $('r-font').onclick = (e) => {
    e.stopPropagation();
    if (pop) return closePop();
    pop = document.createElement('div');
    pop.className = 'pop';
    pop.append(slider('Font size', 'fontSize', 20, 160, 2, (v) => v + 'px'), slider('Line spacing', 'lineHeight', 1, 2.4, 0.05, (v) => v.toFixed(2)));
    pop.addEventListener('click', (ev) => ev.stopPropagation());
    $('r-font').classList.add('on');
    document.querySelector('.transport').appendChild(pop);
  };
  function closePop() {
    pop?.remove();
    pop = null;
    $('r-font').classList.remove('on');
  }
  document.addEventListener('click', () => pop && closePop());

  // ================================================================ settings
  let settingsQueued = false;
  function changeSetting(key, value) {
    settings[key] = value;
    store.saveSettings(settings);
    if (['lineHeight', 'align', 'cuePos'].includes(key)) layoutPreview();
    if (!settingsQueued) {
      settingsQueued = true;
      requestAnimationFrame(() => {
        settingsQueued = false;
        link.send({ t: 'settings', settings });
      });
    }
    // keep duplicate controls (popover + display panel) in sync
    document.querySelectorAll(`[data-key="${key}"]`).forEach((el) => el._sync?.());
  }

  function fill(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--fill', pct + '%');
  }

  function slider(label, key, min, max, step, fmt, sub) {
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `<div class="set-label"><span>${label}</span><b></b></div><input type="range" min="${min}" max="${max}" step="${step}">${sub ? `<div class="set-sub">${sub}</div>` : ''}`;
    const input = row.querySelector('input');
    const out = row.querySelector('b');
    row.dataset.key = key;
    row._sync = () => {
      input.value = settings[key];
      out.textContent = fmt(+settings[key]);
      fill(input);
    };
    input.addEventListener('input', () => {
      changeSetting(key, +input.value);
      out.textContent = fmt(+input.value);
      fill(input);
    });
    row._sync();
    return row;
  }
  function toggleRow(label, key, sub) {
    const row = document.createElement('label');
    row.className = 'set-row toggle';
    row.dataset.key = key;
    row.innerHTML = `<div><div>${label}</div>${sub ? `<div class="set-sub">${sub}</div>` : ''}</div><span class="switch"><input type="checkbox"><span></span></span>`;
    const input = row.querySelector('input');
    row._sync = () => (input.checked = !!settings[key]);
    input.addEventListener('change', () => changeSetting(key, input.checked));
    row._sync();
    return row;
  }
  function segRow(label, key, options) {
    const row = document.createElement('div');
    row.className = 'set-row';
    row.dataset.key = key;
    row.innerHTML = `<div class="set-label"><span>${label}</span></div><div class="seg"></div>`;
    const seg = row.querySelector('.seg');
    for (const [val, text] of options) {
      const b = document.createElement('button');
      b.textContent = text;
      b.onclick = () => changeSetting(key, val);
      b._val = val;
      seg.appendChild(b);
    }
    row._sync = () => [...seg.children].forEach((b) => b.classList.toggle('on', b._val === settings[key]));
    row._sync();
    return row;
  }
  function group(title, rows) {
    const wrap = document.createDocumentFragment();
    const h = document.createElement('div');
    h.className = 'set-title';
    h.textContent = title;
    const g = document.createElement('div');
    g.className = 'set-group';
    g.append(...rows);
    wrap.append(h, g);
    return wrap;
  }

  function buildDisplay() {
    const box = $('d-settings');
    box.replaceChildren(
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
          [3, '3 sec'],
          [5, '5 sec'],
        ]),
      ])
    );
    const reset = document.createElement('button');
    reset.className = 'btn ghost small';
    reset.textContent = 'Reset display to defaults';
    reset.style.cssText = 'display:block;margin:4px auto 0';
    reset.onclick = () => {
      if (!confirm('Reset all display settings?')) return;
      const speed = settings.speed;
      settings = { ...store.DEFAULT_SETTINGS, speed };
      store.saveSettings(settings);
      buildDisplay();
      layoutPreview();
      link.send({ t: 'settings', settings });
    };
    box.appendChild(reset);
  }

  // ================================================================ scripts
  function sortScripts() {
    scripts.sort((a, b) => b.updated - a.updated);
  }
  function persist() {
    store.saveScripts(scripts);
  }
  function renderList() {
    sortScripts();
    const ul = $('s-list');
    ul.replaceChildren(
      ...scripts.map((s) => {
        const li = document.createElement('li');
        li.className = 'script-item' + (s.id === activeId ? ' active' : '');
        const words = wordCount(s.text);
        const main = document.createElement('button');
        main.className = 'si-main';
        main.innerHTML = `<div class="si-title"><span></span>${s.id === activeId ? '<em class="si-badge">On prompter</em>' : ''}</div><div class="si-snip"></div><div class="si-meta"></div>`;
        main.querySelector('.si-title span').textContent = s.title || 'Untitled';
        main.querySelector('.si-snip').textContent = s.text.trim().slice(0, 140) || 'Empty';
        main.querySelector('.si-meta').textContent = `${words} words · ~${fmtTime((words / 150) * 60)} · ${new Date(s.updated).toLocaleDateString()}`;
        main.onclick = () => selectScript(s.id);
        const more = document.createElement('button');
        more.className = 'si-more';
        more.setAttribute('aria-label', 'More');
        more.textContent = '⋯';
        more.onclick = () => scriptActions(s);
        li.append(main, more);
        return li;
      })
    );
  }

  function selectScript(id, { quiet } = {}) {
    activeId = id;
    store.setActiveId(id);
    renderList();
    renderPreview(true);
    pushLoad();
    if (!quiet) {
      toast(link.connected ? 'Loaded on teleprompter' : 'Selected — connect to send it');
      switchTab('live');
    }
  }

  function newScript() {
    const s = { id: store.uid(), title: 'Untitled script', text: '', updated: Date.now() };
    scripts.unshift(s);
    persist();
    selectScript(s.id, { quiet: true });
    openEditor(s.id, true);
  }

  function scriptActions(s) {
    const card = $('actions-card');
    card.replaceChildren();
    const t = document.createElement('div');
    t.className = 'a-title';
    t.textContent = s.title || 'Untitled';
    card.appendChild(t);
    const add = (label, fn, cls = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = cls;
      b.onclick = () => {
        $('actions').hidden = true;
        fn?.();
      };
      card.appendChild(b);
    };
    add('Send to teleprompter', () => selectScript(s.id));
    add('Edit', () => openEditor(s.id));
    add('Duplicate', () => {
      const c = { ...s, id: store.uid(), title: (s.title || 'Untitled') + ' copy', updated: Date.now() };
      scripts.push(c);
      persist();
      renderList();
    });
    add(
      'Delete',
      () => {
        if (scripts.length === 1) return toast('Keep at least one script');
        if (!confirm(`Delete “${s.title || 'Untitled'}”? This can't be undone.`)) return;
        scripts = scripts.filter((x) => x.id !== s.id);
        persist();
        if (activeId === s.id) selectScript(scripts[0].id, { quiet: true });
        renderList();
      },
      'danger'
    );
    add('Cancel', null, 'cancel');
    $('actions').hidden = false;
  }
  $('actions').addEventListener('click', (e) => {
    if (e.target.id === 'actions') $('actions').hidden = true;
  });

  $('s-new').onclick = newScript;

  // backup / restore
  $('s-export').onclick = async () => {
    const data = JSON.stringify({ app: 'prompter', version: 1, exported: new Date().toISOString(), scripts }, null, 2);
    const name = `prompter-scripts-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([data], name, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Prompter scripts' });
        return;
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('s-import').onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = Array.isArray(data) ? data : data.scripts;
      let added = 0;
      for (const s of list || []) {
        if (typeof s?.text !== 'string') continue;
        const existing = scripts.find((x) => x.id === s.id);
        if (existing) {
          if ((s.updated || 0) > existing.updated) Object.assign(existing, s);
        } else {
          scripts.push({ id: s.id || store.uid(), title: String(s.title || 'Imported'), text: s.text, updated: s.updated || Date.now() });
          added++;
        }
      }
      persist();
      renderList();
      toast(`Restored ${added} new script${added === 1 ? '' : 's'}`);
    } catch {
      toast("That file isn't a Prompter backup");
    }
  };

  // ================================================================ editor
  let editingId = null;
  let saveTimer = 0;
  let liveTimer = 0;
  const edTitle = $('ed-title');
  const edText = $('ed-text');

  function openEditor(id, focusTitle) {
    const s = scripts.find((x) => x.id === id);
    if (!s) return;
    editingId = id;
    edTitle.value = s.title;
    edText.value = s.text;
    updateEdStats();
    $('editor').hidden = false;
    fitEditor();
    setTimeout(() => (focusTitle ? edTitle.select() : edText.focus()), 50);
  }
  function updateEdStats() {
    const w = wordCount(edText.value);
    $('ed-stats').textContent = `${w} words · ~${fmtTime((w / 150) * 60)} read`;
    const live = $('ed-live');
    const isLive = editingId === activeId && link.connected;
    live.textContent = isLive ? '● Live on teleprompter' : editingId === activeId ? 'Not connected' : '';
    live.className = isLive ? 'on' : '';
  }
  function onEdit() {
    const s = scripts.find((x) => x.id === editingId);
    if (!s) return;
    s.title = edTitle.value;
    s.text = edText.value;
    s.updated = Date.now();
    updateEdStats();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
    if (s.id === activeId) {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => {
        link.send({ t: 'text', id: s.id, title: s.title, text: s.text });
      }, 200);
    }
  }
  edTitle.addEventListener('input', onEdit);
  edText.addEventListener('input', onEdit);
  $('ed-done').onclick = () => {
    const s = scripts.find((x) => x.id === editingId);
    if (s && !s.title.trim()) s.title = s.text.trim().split('\n')[0].slice(0, 40) || 'Untitled script';
    persist();
    edTitle.blur();
    edText.blur();
    $('editor').hidden = true;
    if (editingId === activeId) {
      renderPreview(false);
      link.send({ t: 'text', id: s.id, title: s.title, text: s.text });
    }
    editingId = null;
    renderList();
  };
  // iOS doesn't shrink the layout for the keyboard; size the editor to the visible area.
  function fitEditor() {
    const ed = $('editor');
    if (ed.hidden || !window.visualViewport) return;
    ed.style.height = visualViewport.height + 'px';
    ed.style.top = visualViewport.offsetTop + 'px';
    ed.style.bottom = 'auto';
  }
  window.visualViewport?.addEventListener('resize', fitEditor);
  window.visualViewport?.addEventListener('scroll', fitEditor);
  $('r-edit').onclick = () => openEditor(activeId);

  // ================================================================ pairing
  const codeIn = $('pair-code');
  function openPair() {
    codeIn.value = link.code || store.getRemoteCode();
    $('pair-forget').hidden = !link.code;
    renderStatus(link.status);
    $('pair').hidden = false;
    setTimeout(() => codeIn.focus(), 60);
  }
  codeIn.addEventListener('input', () => {
    codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (CODE_RE.test(codeIn.value) && codeIn.value !== link.code) connectCode();
  });
  codeIn.addEventListener('keydown', (e) => e.key === 'Enter' && connectCode());
  function connectCode() {
    const c = codeIn.value.trim().toUpperCase();
    if (!CODE_RE.test(c)) {
      const st = $('pair-status');
      st.className = 'pair-status bad';
      st.textContent = 'Codes are 4 letters/numbers, like K7QM.';
      return;
    }
    store.setRemoteCode(c);
    $('pair-forget').hidden = false;
    link.connect(c);
    codeIn.blur();
  }
  $('pair-go').onclick = connectCode;
  $('pair-cancel').onclick = () => ($('pair').hidden = true);
  $('pair-forget').onclick = () => {
    link.disconnect();
    store.setRemoteCode('');
    codeIn.value = '';
    $('pair-forget').hidden = true;
  };
  $('pair').addEventListener('click', (e) => {
    if (e.target.id === 'pair') $('pair').hidden = true;
  });
  pill.onclick = openPair;

  // ================================================================ tabs
  function switchTab(name) {
    tab = name;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $('panel-live').hidden = name !== 'live';
    $('panel-scripts').hidden = name !== 'scripts';
    $('panel-display').hidden = name !== 'display';
    closePop();
    if (name === 'live') requestAnimationFrame(() => layoutPreview());
    if (name === 'scripts') renderList();
  }
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $('r-home').onclick = () => goHome();

  new ResizeObserver(() => active && tab === 'live' && layoutPreview()).observe(preview);

  // ================================================================ lifecycle
  let started = false;
  return {
    enter() {
      active = true;
      view.hidden = false;
      if (!started) {
        started = true;
        buildDisplay();
        syncSpeedUI();
        renderList();
        const code = store.getRemoteCode();
        if (code) link.connect(code);
        else setTimeout(openPair, 300);
      }
      switchTab(tab);
      renderPreview(false);
      lastT = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    },
    leave() {
      active = false;
      view.hidden = true;
      cancelAnimationFrame(raf);
    },
  };
}
