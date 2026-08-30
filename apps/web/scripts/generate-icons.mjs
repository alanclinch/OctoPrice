/**
 * Generates the PWA icon set.
 *
 * Written as a script rather than committing opaque binaries by hand, so the
 * icons can be regenerated or restyled from one place. A tiny PNG encoder is
 * used instead of an image library: the artwork is a flat background and six
 * simple shapes, which is not worth a dependency. The notification badge is
 * a separate transparent monochrome mark, as required by Android status bars.
 *
 * Run with: npm run generate:icons --workspace @octoprice/web
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BACKGROUND = [0x0c, 0x17, 0x18];
const MINT = [0x35, 0xe5, 0x8a];
const CORAL = [0xff, 0x8a, 0x66];

/**
 * Five half-hour price bars flow into a forward pointer. The mark is kept
 * inside the central safe area so it survives every launcher mask.
 */
const PRICE_BARS = [
  { x1: 0.15, y1: 0.58, x2: 0.24, y2: 0.73, colour: MINT },
  { x1: 0.28, y1: 0.46, x2: 0.37, y2: 0.73, colour: MINT },
  { x1: 0.41, y1: 0.28, x2: 0.5, y2: 0.73, colour: CORAL },
  { x1: 0.54, y1: 0.43, x2: 0.63, y2: 0.73, colour: CORAL },
  { x1: 0.67, y1: 0.55, x2: 0.76, y2: 0.73, colour: CORAL },
];
const BAR_RADIUS = 0.022;
const POINTER_SHAPE = [
  [0.75, 0.5],
  [0.91, 0.635],
  [0.75, 0.77],
];
const MASKABLE_MARK_SCALE = 0.9;
const MASKABLE_SAFE_RADIUS = 0.4;

/**
 * Android launchers may retain only the standard central 80% circle. Keep a
 * conservative check over every polygon point and bar corner so future edits
 * cannot silently put the distinguishing arrow outside that safe zone.
 */
function assertMaskableSafeZone() {
  const barCorners = PRICE_BARS.flatMap((bar) => [
    [bar.x1, bar.y1],
    [bar.x2, bar.y1],
    [bar.x2, bar.y2],
    [bar.x1, bar.y2],
  ]);

  for (const [x, y] of [...POINTER_SHAPE, ...barCorners]) {
    const scaledDistance = Math.hypot(x - 0.5, y - 0.5) * MASKABLE_MARK_SCALE;
    assert.ok(
      scaledDistance <= MASKABLE_SAFE_RADIUS,
      `Maskable mark point (${x}, ${y}) exceeds the central safe zone`,
    );
  }
}

assertMaskableSafeZone();

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** Encodes RGBA pixel data as a PNG. */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none".
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Drawing ----------------------------------------------------------------

/** Even-odd point-in-polygon test in unit coordinates. */
function insidePolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** True inside a rounded square covering the whole unit area. */
function insideRoundedSquare(x, y, radius) {
  const dx = Math.max(radius - x, 0, x - (1 - radius));
  const dy = Math.max(radius - y, 0, y - (1 - radius));
  if (dx === 0 || dy === 0) return true;
  return dx * dx + dy * dy <= radius * radius;
}

function insideRoundedRect(rect, x, y, radius) {
  if (x < rect.x1 || x > rect.x2 || y < rect.y1 || y > rect.y2) return false;
  const dx = Math.max(rect.x1 + radius - x, 0, x - (rect.x2 - radius));
  const dy = Math.max(rect.y1 + radius - y, 0, y - (rect.y2 - radius));
  if (dx === 0 || dy === 0) return true;
  return dx * dx + dy * dy <= radius * radius;
}

function markColourAt(x, y) {
  for (const bar of PRICE_BARS) {
    if (insideRoundedRect(bar, x, y, BAR_RADIUS)) return bar.colour;
  }
  return insidePolygon(POINTER_SHAPE, x, y) ? MINT : null;
}

function insideMark(x, y) {
  return markColourAt(x, y) !== null;
}

/**
 * Renders one icon. `maskable` fills the whole square, since the launcher
 * applies its own mask and any corner rounding of ours would be cropped.
 */
function renderIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 3; // 3x3 supersampling, enough to hide the jaggies
  const cornerRadius = 0.22;
  const markScale = maskable ? MASKABLE_MARK_SCALE : 1;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let coverageBackground = 0;
      const colourTotal = [0, 0, 0];

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;

          const inBackground = maskable || insideRoundedSquare(x, y, cornerRadius);
          if (!inBackground) continue;
          coverageBackground += 1;
          const markX = 0.5 + (x - 0.5) / markScale;
          const markY = 0.5 + (y - 0.5) / markScale;
          const colour = markColourAt(markX, markY) ?? BACKGROUND;
          for (let channel = 0; channel < 3; channel += 1) {
            colourTotal[channel] += colour[channel];
          }
        }
      }

      const total = samples * samples;
      const alpha = coverageBackground / total;

      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        rgba[offset + channel] =
          coverageBackground === 0
            ? BACKGROUND[channel]
            : Math.round(colourTotal[channel] / coverageBackground);
      }
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/**
 * Android uses only the alpha channel of notification badges and applies its
 * own colour. A transparent price-pulse mark avoids the solid white square
 * produced when a full launcher icon is supplied here.
 */
function renderBadge(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 3;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let coverage = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (insideMark(x, y)) coverage += 1;
        }
      }

      const offset = (py * size + px) * 4;
      // Android uses the alpha mask; black RGB keeps the source asset visible
      // in ordinary image viewers without changing its rendered tray colour.
      rgba[offset] = 0;
      rgba[offset + 1] = 0;
      rgba[offset + 2] = 0;
      rgba[offset + 3] = Math.round((coverage / (samples * samples)) * 255);
    }
  }

  return encodePng(size, size, rgba);
}

function hex(colour) {
  return `#${colour.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function svgMark() {
  const coordinate = (value) => (value * 512).toFixed(1);
  const bars = PRICE_BARS.map(
    (bar) =>
      `  <rect x="${coordinate(bar.x1)}" y="${coordinate(bar.y1)}" width="${coordinate(bar.x2 - bar.x1)}" height="${coordinate(bar.y2 - bar.y1)}" rx="${coordinate(BAR_RADIUS)}" fill="${hex(bar.colour)}"/>`,
  ).join('\n');
  const pointer = POINTER_SHAPE.map(([x, y]) => `${coordinate(x)},${coordinate(y)}`).join(' ');
  return `${bars}\n  <polygon points="${pointer}" fill="${hex(MINT)}"/>`;
}

function svgIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="OctoAgile Advisor">
  <rect width="512" height="512" rx="113" fill="${hex(BACKGROUND)}"/>
${svgMark()}
</svg>\n`;
}

function svgBrandMark() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="OctoAgile Advisor price pulse">
${svgMark()}
</svg>\n`;
}

mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  ['icon-192.png', renderIcon(192)],
  ['icon-512.png', renderIcon(512)],
  ['icon-maskable-512.png', renderIcon(512, { maskable: true })],
  ['badge-96.png', renderBadge(96)],
  ['icon.svg', Buffer.from(svgIcon(), 'utf8')],
  ['brand-mark.svg', Buffer.from(svgBrandMark(), 'utf8')],
];

for (const [name, data] of outputs) {
  writeFileSync(join(OUT_DIR, name), data);
  process.stdout.write(`${name} (${data.length} bytes)\n`);
}
