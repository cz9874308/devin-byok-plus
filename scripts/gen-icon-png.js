// One-off generator: rasterize the W icon (matching icon.svg) into icon.png
// 128x128, grayscale+alpha, white stroke with anti-aliasing. No external deps.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = 128;
const SCALE = SIZE / 24; // svg viewBox is 24x24
const STROKE = 2.2 * SCALE; // svg stroke-width 2.2
const HALF = STROKE / 2;

// W polyline points from icon.svg: M3 5 L7.5 19 L12 9 L16.5 19 L21 5
const pts = [
  [3, 5],
  [7.5, 19],
  [12, 9],
  [16.5, 19],
  [21, 5],
].map(([x, y]) => [x * SCALE, y * SCALE]);

const segs = [];
for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);

function distToSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Build raw scanlines: colorType 4 => [gray, alpha] per pixel, filter byte per row
const raw = Buffer.alloc((SIZE * 2 + 1) * SIZE);
const SS = 3; // supersample factor for anti-aliasing
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 2 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let inside = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        let d = Infinity;
        for (const s of segs) d = Math.min(d, distToSeg(px, py, s[0], s[1]));
        if (d <= HALF) inside++;
      }
    }
    const alpha = Math.round((inside / (SS * SS)) * 255);
    const o = rowStart + 1 + x * 2;
    raw[o] = 255; // gray = white
    raw[o + 1] = alpha;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const crcTable = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 4; // color type: grayscale + alpha
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'resources', 'icons', 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
