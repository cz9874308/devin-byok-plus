// One-off generator: rasterize the Devin official logo (matching icon.svg) into icon.png
// 128x128, grayscale+alpha, white fill with anti-aliasing. No external deps.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = 128;
const VIEWBOX = 425; // svg viewBox is 425x425
const SCALE = SIZE / VIEWBOX;

// Devin official logo path from icon.svg (viewBox 0 0 425 425)
const PATH_D =
  'M70 159.333V91.3471C70 88.3592 71.594 85.5983 74.1816 84.1044L133.043 50.1205C135.631 48.6265 138.819 48.6265 141.407 50.1205L200.269 84.1044C202.856 85.5983 204.45 88.3592 204.45 91.3471V126.068C204.708 137.606 210.806 148.734 221.531 154.926C232.256 161.117 244.942 160.834 255.063 155.289L285.132 137.929C287.719 136.435 290.907 136.435 293.495 137.929L352.357 171.913C354.944 173.406 356.538 176.167 356.538 179.155V247.123C356.538 250.111 354.944 252.872 352.357 254.366L293.495 288.35C290.907 289.844 287.719 289.844 285.132 288.35L255.306 271.13C245.146 265.456 232.344 265.117 221.534 271.358C210.809 277.55 204.711 288.678 204.453 300.215V334.926C204.453 337.914 202.859 340.675 200.271 342.169L141.41 376.153C138.822 377.647 135.634 377.647 133.046 376.153L74.1845 342.169C71.5969 340.675 70.0028 337.914 70.0028 334.926V266.959C70.0029 263.971 71.5969 261.21 74.1845 259.716L133.046 225.732C135.634 224.238 138.822 224.238 141.41 225.732L171.547 243.132C181.656 248.638 194.306 248.906 205.005 242.729C215.815 236.488 221.922 225.231 222.088 213.595C221.83 202.057 215.732 189.737 205.008 183.545C194.283 177.353 181.597 177.636 171.476 183.181L141.269 200.72C138.67 202.229 135.461 202.228 132.864 200.716L74.1576 166.562C71.5835 165.065 70 162.311 70 159.333Z';

// Parse absolute SVG path (supports M, L, H, V, C, Z) into a flat polygon (subpath).
function parsePath(d) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  const poly = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let cmd = '';
  const num = () => parseFloat(tokens[i++]);
  const push = (x, y) => poly.push([x * SCALE, y * SCALE]);
  const bezier = (x0, y0, x1, y1, x2, y2, x3, y3) => {
    const N = 24;
    for (let s = 1; s <= N; s++) {
      const t = s / N;
      const mt = 1 - t;
      const x = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
      const y = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
      push(x, y);
    }
  };
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/[a-zA-Z]/.test(tok)) {
      cmd = tok;
      i++;
    }
    switch (cmd) {
      case 'M':
        cx = num();
        cy = num();
        push(cx, cy);
        cmd = 'L';
        break;
      case 'L':
        cx = num();
        cy = num();
        push(cx, cy);
        break;
      case 'H':
        cx = num();
        push(cx, cy);
        break;
      case 'V':
        cy = num();
        push(cx, cy);
        break;
      case 'C': {
        const x1 = num();
        const y1 = num();
        const x2 = num();
        const y2 = num();
        const x3 = num();
        const y3 = num();
        bezier(cx, cy, x1, y1, x2, y2, x3, y3);
        cx = x3;
        cy = y3;
        break;
      }
      case 'Z':
      case 'z':
        break;
      default:
        i++;
    }
  }
  return poly;
}

const poly = parsePath(PATH_D);

// Even-odd point-in-polygon test.
function inside(px, py, pts) {
  let hit = false;
  for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
    const [xi, yi] = pts[a];
    const [xj, yj] = pts[b];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      hit = !hit;
    }
  }
  return hit;
}

// Build raw scanlines: colorType 4 => [gray, alpha] per pixel, filter byte per row
const raw = Buffer.alloc((SIZE * 2 + 1) * SIZE);
const SS = 4; // supersample factor for anti-aliasing
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 2 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let cover = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (inside(px, py, poly)) cover++;
      }
    }
    const alpha = Math.round((cover / (SS * SS)) * 255);
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
