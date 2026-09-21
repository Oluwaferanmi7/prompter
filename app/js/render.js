// Shared script rendering + position math.
//
// Both devices render the same script as one block per line ("paragraph"), but wrap it
// differently (different screens, fonts). So positions travel as an *anchor*:
// { p: paragraph index, f: 0..1 fraction through that paragraph } measured at the reading
// line. Each side converts anchor <-> its own pixel offset `y`, where y = the content
// coordinate currently sitting on the reading line.

export function renderScript(contentEl, text) {
  const frag = document.createDocumentFragment();
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, i) => {
    const d = document.createElement('div');
    d.className = 'para' + (line.trim() ? '' : ' blank');
    d.dataset.i = i;
    d.textContent = line.trim() ? line : ' ';
    frag.appendChild(d);
  });
  contentEl.replaceChildren(frag);
}

// Snapshot paragraph geometry. contentEl must be position:relative so offsetTop is
// relative to it (and unaffected by ancestor transforms such as mirroring).
export function measure(contentEl) {
  const kids = contentEl.children;
  const tops = new Float64Array(kids.length);
  const heights = new Float64Array(kids.length);
  for (let i = 0; i < kids.length; i++) {
    tops[i] = kids[i].offsetTop;
    heights[i] = kids[i].offsetHeight;
  }
  const total = kids.length ? tops[kids.length - 1] + heights[kids.length - 1] : 0;
  return { tops, heights, total, count: kids.length };
}

export function anchorAt(y, m) {
  if (!m.count) return { p: 0, f: 0 };
  if (y <= 0) return { p: 0, f: 0 };
  if (y >= m.total) return { p: m.count - 1, f: 1 };
  // binary search last paragraph with top <= y
  let lo = 0;
  let hi = m.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (m.tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  const h = m.heights[lo] || 1;
  return { p: lo, f: Math.min(1, Math.max(0, (y - m.tops[lo]) / h)) };
}

export function yForAnchor(a, m) {
  if (!m.count || !a) return 0;
  const p = Math.min(m.count - 1, Math.max(0, a.p | 0));
  return m.tops[p] + (m.heights[p] || 0) * Math.min(1, Math.max(0, a.f || 0));
}

// Top of the next / previous non-blank paragraph relative to the one at y.
export function paraStep(y, m, contentEl, dir) {
  if (!m.count) return 0;
  const cur = anchorAt(y + 1, m).p;
  const blank = (i) => contentEl.children[i]?.classList.contains('blank');
  let i = cur;
  if (dir > 0) {
    i = cur + 1;
    while (i < m.count && blank(i)) i++;
    if (i >= m.count) return m.total;
  } else {
    // If we're well into the current paragraph, go to its start first.
    if (y - m.tops[cur] > 8 && !blank(cur)) return m.tops[cur];
    i = cur - 1;
    while (i > 0 && blank(i)) i--;
    if (i < 0) return 0;
  }
  return m.tops[i];
}

export const THEMES = {
  white: { fg: '#ffffff', bg: '#000000', cue: '#ff4d3d' },
  yellow: { fg: '#ffe14d', bg: '#000000', cue: '#ff4d3d' },
  light: { fg: '#111111', bg: '#ffffff', cue: '#e0301e' },
};

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '–:––';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function wordCount(text) {
  const m = String(text || '').match(/\S+/g);
  return m ? m.length : 0;
}
