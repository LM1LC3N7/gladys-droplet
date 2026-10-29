// Generates cover.png (800x534) for gladys-droplet: plain Node, no dependency.
// Water drops, a pipe with a clamp-on flow sensor, the readings sent on the
// home network and a home, on a gradient (no brand logo). Taken from
// gladys-sunpower-pvs (same author).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.7 + (y / H) * 0.3;
  return [60 + 40 * t, 150 - 90 * t, 220 - 110 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [28, 38, 64];
const green = [90, 210, 130];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

disc(400, 270, 260, white, 0.05);
const pipe = [190, 200, 215];
const pipeDark = [120, 135, 160];
const water = [80, 190, 250];

// A water drop, top left (a disc under a triangle).
const drop = (cx, cy, r, color) => {
  disc(cx, cy, r, color);
  for (let y = cy - 2.2 * r; y < cy; y += 1) {
    const half = (r * (y - (cy - 2.2 * r))) / (2.2 * r);
    for (let x = cx - half; x <= cx + half; x += 1) set(Math.round(x), Math.round(y), color);
  }
};
drop(120, 130, 40, water);
drop(200, 95, 22, water);

// The pipe across the picture, with the water flowing in it (arrows).
box(40, 250, 760, 330, 30, pipe);
line(60, 258, 740, 258, 6, white);
line(60, 322, 740, 322, 4, pipeDark);
for (let k = 0; k < 4; k += 1) {
  const x = 90 + k * 60;
  line(x, 290, x + 30, 290, 6, water);
  line(x + 30, 290, x + 18, 280, 6, water);
  line(x + 30, 290, x + 18, 300, 6, water);
}

// The flow sensor clamped on the pipe (a rounded box, its status ring and reading).
box(380, 205, 560, 375, 34, white);
box(392, 217, 548, 363, 26, dark);
disc(470, 290, 46, water, 0.9);
disc(470, 290, 32, dark);
line(452, 290, 488, 290, 6, white);
disc(470, 248, 5, green);

// Waves on the right: the readings sent on the home network.
for (let k = 0; k < 3; k += 1) {
  const r = 30 + k * 22;
  for (let a = -0.7; a <= 0.7; a += 0.02) {
    disc(600 + r * Math.cos(a), 150 + r * Math.sin(a), 3, white);
  }
}

// The home, bottom right.
box(610, 400, 740, 500, 10, white);
line(600, 405, 675, 345, 12, white);
line(675, 345, 750, 405, 12, white);
box(660, 445, 690, 500, 4, dark);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
