// Turns a phone recording into a normal MP4 that any player can scrub.
//
// The recorder writes a "fragmented" MP4: a short header, then one piece (moof + mdat) per
// second, and no index. The iPhone copes; Windows players show a grey timeline. Here the
// pieces' own tables are read and one index (moov with full sample tables) is written at
// the front, followed by the same media bytes. Nothing is re-encoded: every frame and audio
// packet is the recorder's, byte for byte, with the same timing. The media itself is never
// copied into memory either: the new file is the new header plus slices of the old Blob,
// so an hour-long take costs a few MB.
//
// fixMp4(blob) → Blob of the normal MP4, or null if the file isn't fragmented (nothing to
// do) or can't be read (the caller keeps the original).

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex']);
const DROP_FROM_STBL = new Set(['stts', 'ctts', 'stsc', 'stsz', 'stz2', 'stco', 'co64', 'stss', 'sdtp', 'sbgp', 'sgpd', 'subs', 'saiz', 'saio']);
const u64 = (dv, o) => dv.getUint32(o) * 2 ** 32 + dv.getUint32(o + 4);
const type4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

async function read(blob, start, len) {
  return new Uint8Array(await blob.slice(start, Math.min(blob.size, start + len)).arrayBuffer());
}

// Boxes inside bytes[start, end): { type, start, end, body } (body = after the header).
function boxes(bytes, start = 0, end = bytes.length) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    let hdr = 8;
    if (size === 1) {
      size = u64(dv, o + 8);
      hdr = 16;
    } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    out.push({ type: type4(bytes, o + 4), start: o, end: o + size, body: o + hdr });
    o += size;
  }
  return out;
}
// Tree of the header (moov): containers get kids, everything else stays raw.
function tree(bytes, start, end) {
  return boxes(bytes, start, end).map((b) => ({
    type: b.type,
    raw: bytes.subarray(b.start, b.end),
    body: bytes.subarray(b.body, b.end),
    kids: CONTAINERS.has(b.type) ? tree(bytes, b.body, b.end) : null,
  }));
}
const kid = (node, type) => node.kids?.find((k) => k.type === type);

// ------------------------------------------------------------------ writing
function box(type, ...parts) {
  const len = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  new DataView(out.buffer).setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}
// Full box body: version/flags then 32-bit (or 64-bit) numbers.
function words(version, values, bits = 32) {
  const out = new Uint8Array(4 + values.length * (bits / 8));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, version << 24);
  values.forEach((v, i) => {
    if (bits === 64) {
      dv.setUint32(4 + i * 8, Math.floor(v / 2 ** 32));
      dv.setUint32(8 + i * 8, v >>> 0);
    } else dv.setUint32(4 + i * 4, v >>> 0);
  });
  return out;
}
const serialize = (node) => (node.kids ? box(node.type, ...node.kids.map(serialize)) : node.raw);
// A copy of a leaf box with one duration field rewritten (v0: 32-bit, v1: 64-bit).
function withDuration(node, off0, off1, value) {
  const raw = node.raw.slice();
  const dv = new DataView(raw.buffer);
  const v1 = raw[8] === 1;
  if (v1) {
    dv.setUint32(8 + off1, Math.floor(value / 2 ** 32));
    dv.setUint32(12 + off1, value >>> 0);
  } else dv.setUint32(8 + off0, Math.min(value, 0xffffffff) >>> 0);
  return { ...node, raw };
}

// ------------------------------------------------------------------ main
export async function fixMp4(blob) {
  // 1. Walk the top level: header boxes, every moof (small) and where each mdat's media is.
  let moov = null;
  const moofs = [];
  const mdats = []; // { start, end } of the media bytes, in file order
  for (let pos = 0; pos + 8 <= blob.size; ) {
    let head = await read(blob, pos, 4096);
    const dv = new DataView(head.buffer);
    let size = dv.getUint32(0);
    let hdr = 8;
    if (size === 1) (size = u64(dv, 8)), (hdr = 16);
    else if (size === 0) size = blob.size - pos;
    const type = type4(head, 4);
    if (size < hdr || pos + size > blob.size) break; // cut short (recovered take): keep what's whole
    if (type === 'moov' || type === 'moof') {
      if (size > head.length) head = await read(blob, pos, size);
      const bytes = head.subarray(0, size);
      if (type === 'moov') moov = bytes;
      else moofs.push({ pos, bytes });
    } else if (type === 'mdat') mdats.push({ start: pos + hdr, end: pos + size });
    pos += size;
  }
  if (!moov || !moofs.length || !mdats.length) return null;

  // 2. The header: tracks, their timescales and fragment defaults.
  const root = tree(moov, 0, moov.length)[0];
  if (root?.type !== 'moov') return null;
  const mvhd = kid(root, 'mvhd');
  const movieScale = new DataView(mvhd.body.buffer, mvhd.body.byteOffset).getUint32(mvhd.body[0] === 1 ? 20 : 12);
  const trex = new Map();
  for (const t of kid(root, 'mvex')?.kids || []) {
    if (t.type !== 'trex') continue;
    const d = new DataView(t.body.buffer, t.body.byteOffset);
    trex.set(d.getUint32(4), { desc: d.getUint32(8), dur: d.getUint32(12), size: d.getUint32(16), flags: d.getUint32(20) });
  }
  const tracks = new Map();
  for (const trak of root.kids.filter((k) => k.type === 'trak')) {
    const tkhd = kid(trak, 'tkhd');
    const mdhd = kid(kid(trak, 'mdia'), 'mdhd');
    const td = new DataView(tkhd.body.buffer, tkhd.body.byteOffset);
    const md = new DataView(mdhd.body.buffer, mdhd.body.byteOffset);
    const id = td.getUint32(tkhd.body[0] === 1 ? 20 : 12);
    tracks.set(id, {
      id,
      trak,
      scale: md.getUint32(mdhd.body[0] === 1 ? 20 : 12),
      def: trex.get(id) || { desc: 1, dur: 0, size: 0, flags: 0 },
      start: null, // first decode time (tfdt)
      dts: 0,
      durs: [],
      sizes: [],
      sync: [],
      cts: [],
      ctsV1: false,
      chunks: [], // { pos, n } in the original file
    });
  }

  // 3. Every fragment's sample tables, appended per track.
  const inMdat = (pos, len) => mdats.some((m) => pos >= m.start && pos + len <= m.end);
  for (const { pos: moofPos, bytes } of moofs) {
    let prevEnd = moofPos;
    for (const traf of boxes(bytes, 8, bytes.length).filter((b) => b.type === 'traf')) {
      const kids = boxes(bytes, traf.body, traf.end);
      const dv = new DataView(bytes.buffer, bytes.byteOffset);
      const tfhd = kids.find((k) => k.type === 'tfhd');
      if (!tfhd) continue;
      let o = tfhd.body;
      const tf = dv.getUint32(o) & 0xffffff;
      const tr = tracks.get(dv.getUint32(o + 4));
      if (!tr) continue;
      o += 8;
      let base = tf & 0x20000 ? moofPos : prevEnd;
      if (tf & 0x1) (base = u64(dv, o)), (o += 8);
      if (tf & 0x2) o += 4;
      const dDur = tf & 0x8 ? dv.getUint32((o += 4) - 4) : tr.def.dur;
      const dSize = tf & 0x10 ? dv.getUint32((o += 4) - 4) : tr.def.size;
      const dFlags = tf & 0x20 ? dv.getUint32((o += 4) - 4) : tr.def.flags;

      const tfdt = kids.find((k) => k.type === 'tfdt');
      if (tfdt) {
        const t = dv.getUint8(tfdt.body) === 1 ? u64(dv, tfdt.body + 4) : dv.getUint32(tfdt.body + 4);
        if (tr.start === null) tr.start = t;
        else if (tr.durs.length && t !== tr.dts) tr.durs[tr.durs.length - 1] = Math.max(0, tr.durs[tr.durs.length - 1] + t - tr.dts); // keep each sample at its real time
        tr.dts = t;
      }
      if (tr.start === null) tr.start = 0;

      let next = base;
      for (const run of kids.filter((k) => k.type === 'trun')) {
        let r = run.body;
        const vf = dv.getUint32(r);
        const rf = vf & 0xffffff;
        const count = dv.getUint32(r + 4);
        r += 8;
        let at = next;
        if (rf & 0x1) (at = base + dv.getInt32(r)), (r += 4);
        let first = null;
        if (rf & 0x4) (first = dv.getUint32(r)), (r += 4);
        const durs = [];
        const sizes = [];
        const sync = [];
        const cts = [];
        let total = 0;
        for (let i = 0; i < count; i++) {
          const d = rf & 0x100 ? dv.getUint32((r += 4) - 4) : dDur;
          const s = rf & 0x200 ? dv.getUint32((r += 4) - 4) : dSize;
          const f = rf & 0x400 ? dv.getUint32((r += 4) - 4) : i === 0 && first !== null ? first : dFlags;
          const c = rf & 0x800 ? (vf >>> 24 === 1 ? dv.getInt32((r += 4) - 4) : dv.getUint32((r += 4) - 4)) : 0;
          durs.push(d);
          sizes.push(s);
          sync.push(!(f & 0x10000));
          cts.push(c);
          total += s;
        }
        next = at + total;
        if (!count || !inMdat(at, total)) continue; // media missing (cut-short take): skip it
        tr.durs.push(...durs);
        tr.sizes.push(...sizes);
        tr.sync.push(...sync);
        tr.cts.push(...cts);
        if (vf >>> 24 === 1) tr.ctsV1 = true;
        tr.chunks.push({ pos: at, n: count });
        tr.dts += durs.reduce((a, b) => a + b, 0);
      }
      prevEnd = next;
    }
  }

  // 4. The media goes into one mdat, in the same order; work out where each chunk lands.
  const mediaBytes = mdats.reduce((n, m) => n + (m.end - m.start), 0);
  let acc = 0;
  const mdatAt = mdats.map((m) => ((acc += m.end - m.start), acc - (m.end - m.start))); // offset of each within the new media
  const newPos = (pos) => {
    let lo = 0;
    let hi = mdats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (mdats[mid].start <= pos) lo = mid;
      else hi = mid - 1;
    }
    return mdatAt[lo] + (pos - mdats[lo].start);
  };

  const ftypOut = box('ftyp', new Uint8Array([105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 105, 115, 111, 50, 97, 118, 99, 49, 109, 112, 52, 49])); // isom 512: isom iso2 avc1 mp41
  const bigMdat = mediaBytes + 8 > 0xffffffff;
  const mdatHead = new Uint8Array(bigMdat ? 16 : 8);
  const mh = new DataView(mdatHead.buffer);
  mdatHead.set([109, 100, 97, 116], 4); // "mdat"
  if (bigMdat) {
    mh.setUint32(0, 1);
    mh.setUint32(8, Math.floor((mediaBytes + 16) / 2 ** 32));
    mh.setUint32(12, (mediaBytes + 16) >>> 0);
  } else mh.setUint32(0, mediaBytes + 8);

  const toMovie = (t, tr) => Math.round((t * movieScale) / tr.scale);
  const buildMoov = (dataStart, co64) => {
    let movieDur = 0;
    const traks = [];
    for (const tr of tracks.values()) {
      const n = tr.sizes.length;
      if (!n) continue;
      const mediaDur = tr.durs.reduce((a, b) => a + b, 0);
      const delay = toMovie(tr.start || 0, tr);
      const trackDur = delay + toMovie(mediaDur, tr);
      movieDur = Math.max(movieDur, trackDur);

      // stts / ctts: run-length (value, count)
      const rle = (arr) => {
        const out = [];
        for (const v of arr) {
          if (out.length && out[out.length - 1][1] === v) out[out.length - 1][0]++;
          else out.push([1, v]);
        }
        return out;
      };
      const stts = rle(tr.durs);
      const stsc = [];
      tr.chunks.forEach((c, i) => {
        if (!stsc.length || stsc[stsc.length - 1][1] !== c.n) stsc.push([i + 1, c.n, 1]);
      });
      const sameSize = tr.sizes.every((s) => s === tr.sizes[0]);
      const stbl = kid(kid(kid(tr.trak, 'mdia'), 'minf'), 'stbl');
      const tables = [
        box('stts', words(0, [stts.length, ...stts.flat()])),
        ...(tr.cts.some((c) => c) ? [box('ctts', words(tr.ctsV1 ? 1 : 0, [rle(tr.cts).length, ...rle(tr.cts).flat()]))] : []),
        box('stsc', words(0, [stsc.length, ...stsc.flat()])),
        box('stsz', words(0, sameSize ? [tr.sizes[0], n] : [0, n, ...tr.sizes])),
        co64
          ? box('co64', words(0, [tr.chunks.length]), words(0, tr.chunks.map((c) => dataStart + newPos(c.pos)), 64).subarray(4))
          : box('stco', words(0, [tr.chunks.length, ...tr.chunks.map((c) => dataStart + newPos(c.pos))])),
        ...(tr.sync.every(Boolean) ? [] : [box('stss', words(0, [tr.sync.filter(Boolean).length, ...tr.sync.flatMap((s, i) => (s ? [i + 1] : []))]))]),
      ];
      const newStbl = { ...stbl, kids: [...stbl.kids.filter((k) => !DROP_FROM_STBL.has(k.type)), ...tables.map((raw) => ({ type: '', raw }))] };
      const mdia = kid(tr.trak, 'mdia');
      const minf = kid(mdia, 'minf');
      const newMdia = {
        ...mdia,
        kids: mdia.kids.map((k) =>
          k.type === 'mdhd' ? withDuration(k, 16, 24, mediaDur) : k.type === 'minf' ? { ...minf, kids: minf.kids.map((m) => (m.type === 'stbl' ? newStbl : m)) } : k
        ),
      };
      // An edit list keeps a track that started late (e.g. video 40 ms after audio) in sync.
      const edits = delay > 0 ? [[delay, 0xffffffff, 0x10000], [toMovie(mediaDur, tr), 0, 0x10000]] : null;
      const kids = [];
      for (const k of tr.trak.kids) {
        if (k.type === 'edts') continue;
        if (k.type === 'tkhd') {
          kids.push(withDuration(k, 20, 28, trackDur));
          if (edits) kids.push({ type: 'edts', raw: box('edts', box('elst', words(0, [edits.length, ...edits.flat()]))) });
        } else kids.push(k.type === 'mdia' ? newMdia : k);
      }
      traks.push({ ...tr.trak, kids });
    }
    const kids = [];
    for (const k of root.kids) {
      if (k.type === 'mvex' || k.type === 'trak') continue;
      kids.push(k.type === 'mvhd' ? withDuration(k, 16, 24, movieDur) : k);
      if (k.type === 'mvhd') kids.push(...traks);
    }
    return serialize({ type: 'moov', kids });
  };
  // Build once to learn the header's size, then again with the real offsets.
  let co64 = false;
  let moovOut = buildMoov(0, co64);
  if (ftypOut.length + moovOut.length + mdatHead.length + mediaBytes > 0xffffffff) moovOut = buildMoov(0, (co64 = true));
  const dataStart = ftypOut.length + moovOut.length + mdatHead.length;
  moovOut = buildMoov(dataStart, co64);

  return new Blob([ftypOut, moovOut, mdatHead, ...mdats.map((m) => blob.slice(m.start, m.end))], { type: 'video/mp4' });
}
