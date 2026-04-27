// One-off helper: generate icon PNGs for the extension using only Node stdlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makePng(size, draw) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      const off = y * stride + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Anti-aliased disk: returns alpha 0..1 based on distance from center vs radius.
function diskAA(dx, dy, r) {
  const d = Math.sqrt(dx * dx + dy * dy);
  const aa = Math.max(0, Math.min(1, r - d + 0.5));
  return aa;
}

// Anti-aliased rounded square mask
function roundRectAA(x, y, size, radius) {
  const r = radius;
  let cx = x, cy = y;
  if (x < r && y < r) return diskAA(x - r, y - r, r);
  if (x > size - 1 - r && y < r) return diskAA(x - (size - 1 - r), y - r, r);
  if (x < r && y > size - 1 - r) return diskAA(x - r, y - (size - 1 - r), r);
  if (x > size - 1 - r && y > size - 1 - r) return diskAA(x - (size - 1 - r), y - (size - 1 - r), r);
  return 1;
}

function blend(over, under) {
  const a = over[3] / 255;
  return [
    Math.round(over[0] * a + under[0] * (1 - a)),
    Math.round(over[1] * a + under[1] * (1 - a)),
    Math.round(over[2] * a + under[2] * (1 - a)),
    Math.max(over[3], under[3]),
  ];
}

function drawPixel(x, y, size) {
  // Background: rounded dark navy square
  const cornerRadius = size * 0.22;
  const bgMask = roundRectAA(x, y, size, cornerRadius);

  // Moon: crescent = big disk - offset disk
  const cx = size * 0.5;
  const cy = size * 0.5;
  const moonR = size * 0.32;
  const cutR = size * 0.30;
  const cutOffX = size * 0.18;
  const cutOffY = -size * 0.06;

  const inMoon = diskAA(x - cx, y - cy, moonR);
  const inCut = diskAA(x - (cx + cutOffX), y - (cy + cutOffY), cutR);
  const moonAlpha = Math.max(0, inMoon - inCut);

  // Layered: transparent -> bg -> moon
  const transparent = [0, 0, 0, 0];
  const bgColor = [28, 33, 51, Math.round(255 * bgMask)];
  const moonColor = [255, 207, 86, Math.round(255 * moonAlpha)];

  let px = blend(bgColor, transparent);
  px = blend(moonColor, px);
  return px;
}

const sizes = [16, 48, 128];
const outDir = path.join(__dirname, 'icons');
for (const s of sizes) {
  const png = makePng(s, drawPixel);
  fs.writeFileSync(path.join(outDir, `icon${s}.png`), png);
  console.log(`wrote icon${s}.png (${png.length} bytes)`);
}
