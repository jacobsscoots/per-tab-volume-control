#!/usr/bin/env node
// Run once: node icons/generate.js
// Creates icon16.png, icon48.png, icon128.png in this directory.
// Requires only Node.js built-ins (zlib, fs, path, crypto).

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 (needed for PNG chunks) ──────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([l, t, data, crcBuf]);
}

// ── PNG builder (RGB, no alpha) ────────────────────────────────────────────

function makePNG(size, drawFn) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  // Raw scanlines: [filter=0, R, G, B, R, G, B, ...]
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const [r, g, b] = drawFn(x, y, size);
      const off = y * (size * 3 + 1) + 1 + x * 3;
      raw[off] = r; raw[off+1] = g; raw[off+2] = b;
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── Speaker icon draw function ─────────────────────────────────────────────
// Draws a simple speaker + sound waves icon in purple on transparent bg
// (we fake transparency with a near-white/near-dark background that matches
// Chrome's toolbar; for a proper transparent look the icon uses the theme bg).

function draw(x, y, size) {
  const cx = size / 2, cy = size / 2;
  const s  = size / 16; // scale factor

  // Background: white (Chrome handles transparency in icons via the alpha
  // channel we're not using here; solid bg looks fine in the toolbar)
  let r = 255, g = 255, b = 255;

  // Normalized coordinates
  const nx = x / size, ny = y / size;

  // Purple: 108, 99, 255
  const PR = 108, PG = 99, PB = 255;

  // Speaker body: rect from 0.2–0.45 x, 0.35–0.65 y
  if (nx >= 0.18 && nx <= 0.42 && ny >= 0.34 && ny <= 0.66) {
    r = PR; g = PG; b = PB;
  }

  // Trapezoid / cone: triangle pointing left from x=0.42, spanning y 0.2–0.8
  // Points: (0.42, 0.35), (0.42, 0.65), (0.62, 0.2), (0.62, 0.8)
  // Use simple bounding + slope check
  if (nx >= 0.42 && nx <= 0.62) {
    const spread = 0.15 + (nx - 0.42) / 0.20 * 0.3;
    if (ny >= 0.5 - spread && ny <= 0.5 + spread) {
      r = PR; g = PG; b = PB;
    }
  }

  // Sound wave arcs (small, medium) — approximate with arc ranges
  function arc(cx2, cy2, ri, ro, a0, a1) {
    const dx = nx - cx2, dy = ny - cy2;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const angle = Math.atan2(dy, dx);
    if (dist >= ri && dist <= ro && angle >= a0 && angle <= a1) {
      r = PR; g = PG; b = PB;
    }
  }

  const arcX = 0.56, arcY = 0.50;
  // Small arc: radius 0.12–0.18, angles -50° to 50°
  arc(arcX, arcY, 0.12, 0.17, -0.87, 0.87);
  // Medium arc: radius 0.22–0.28
  arc(arcX, arcY, 0.22, 0.27, -0.87, 0.87);

  // Anti-alias: blend at edges (simple, not true AA)
  return [r, g, b];
}

// ── Write icons ────────────────────────────────────────────────────────────

const outDir = __dirname;
for (const size of [16, 48, 128]) {
  const png = makePNG(size, draw);
  const outPath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Created ${outPath} (${png.length} bytes)`);
}
console.log('Done.');
