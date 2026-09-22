// Renders the app icons as PNGs with no dependencies (signed-distance shapes, 4x4 AA).
// Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('../app/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// signed distance helpers (unit coordinates 0..1)
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdCapsule = (x, y, x0, x1, cy, r) => {
  const px = Math.max(x0, Math.min(x1, x));
  return Math.hypot(x - px, y - cy) - r;
};
// right-pointing triangle with apex (ax, cy), base at bx, half-height h
const inTriangle = (x, y, bx, ax, cy, h) => {
  if (x < bx || x > ax) return false;
  const t = (x - bx) / (ax - bx);
  return Math.abs(y - cy) <= h * (1 - t);
};

function shade(u, v, { rounded, scale }) {
  // scale < 1 shrinks the artwork toward the center (for maskable safe zone)
  const x = 0.5 + (u - 0.5) / scale;
  const y = 0.5 + (v - 0.5) / scale;
  let a = 1;
  if (rounded && sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.225) > 0) a = 0;
  // background: deep charcoal with a subtle warm glow at the cue line
  const glow = Math.exp(-(((v - 0.5) / 0.22) ** 2)) * 0.18;
  let r = 51 + 60 * glow - v * 14;
  let g = 51 + 40 * glow - v * 14;
  let b = 51 + 10 * glow - v * 12;
  const put = (cr, cg, cb, alpha) => {
    r = r * (1 - alpha) + cr * alpha;
    g = g * (1 - alpha) + cg * alpha;
    b = b * (1 - alpha) + cb * alpha;
  };
  const lines = [
    [0.33, 0.3, 0.74, 0.4],
    [0.5, 0.3, 0.8, 1],
    [0.67, 0.3, 0.62, 0.4],
  ];
  for (const [cy, x0, x1, alpha] of lines) if (sdCapsule(x, y, x0, x1, cy, 0.042) <= 0) put(...(alpha === 1 ? [246, 241, 241] : [216, 218, 218]), alpha === 1 ? 1 : 0.55);
  if (inTriangle(x, y, 0.12, 0.235, 0.5, 0.07)) put(255, 222, 89, 1);
  return [r, g, b, a * 255];
}

function render(size, opts) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let R = 0,
        G = 0,
        B = 0,
        A = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const [r, g, b, a] = shade((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size, opts);
          R += r * a;
          G += g * a;
          B += b * a;
          A += a;
        }
      const i = (py * size + px) * 4;
      buf[i] = A ? R / A : 0;
      buf[i + 1] = A ? G / A : 0;
      buf[i + 2] = A ? B / A : 0;
      buf[i + 3] = A / (S * S);
    }
  }
  return png(size, buf);
}

const files = {
  'icon-192.png': render(192, { rounded: true, scale: 1 }),
  'icon-512.png': render(512, { rounded: true, scale: 1 }),
  'icon-512-maskable.png': render(512, { rounded: false, scale: 0.8 }),
  'apple-touch-icon.png': render(180, { rounded: false, scale: 1 }),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(new URL(name, OUT), data);
  console.log(name, data.length, 'bytes');
}
