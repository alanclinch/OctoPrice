/**
 * Generates the PWA icon set.
 *
 * Written as a script rather than committing opaque binaries by hand, so the
 * icons can be regenerated or restyled from one place. A tiny PNG encoder is
 * used instead of an image library: the artwork is a flat background and one
 * polygon, which is not worth a dependency.
 *
 * Run with: npm run generate:icons --workspace @octoprice/web
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BACKGROUND = [0x10, 0x17, 0x25];
const BOLT = [0x9a, 0xe6, 0x6e];

/**
 * A lightning bolt in unit coordinates, drawn clockwise from the top.
 * Kept inside the middle 80% so it survives a maskable circular crop.
 */
const BOLT_SHAPE = [
  [0.6, 0.1],
  [0.3, 0.54],
  [0.47, 0.54],
  [0.41, 0.9],
  [0.71, 0.44],
  [0.53, 0.44],
];

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

/**
 * Renders one icon. `maskable` fills the whole square, since the launcher
 * applies its own mask and any corner rounding of ours would be cropped.
 */
function renderIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 3; // 3x3 supersampling, enough to hide the jaggies
  const cornerRadius = 0.22;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let coverageBackground = 0;
      let coverageBolt = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;

          const inBackground = maskable || insideRoundedSquare(x, y, cornerRadius);
          if (!inBackground) continue;
          coverageBackground += 1;
          if (insidePolygon(BOLT_SHAPE, x, y)) coverageBolt += 1;
        }
      }

      const total = samples * samples;
      const alpha = coverageBackground / total;
      const boltRatio = coverageBackground === 0 ? 0 : coverageBolt / coverageBackground;

      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        rgba[offset + channel] = Math.round(
          BACKGROUND[channel] * (1 - boltRatio) + BOLT[channel] * boltRatio,
        );
      }
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

function svgIcon() {
  const points = BOLT_SHAPE.map(([x, y]) => `${(x * 512).toFixed(1)},${(y * 512).toFixed(1)}`).join(
    ' ',
  );
  const bg = `#${BACKGROUND.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  const bolt = `#${BOLT.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="OctoPrice">
  <rect width="512" height="512" rx="113" fill="${bg}"/>
  <polygon points="${points}" fill="${bolt}"/>
</svg>
`;
}

mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  ['icon-192.png', renderIcon(192)],
  ['icon-512.png', renderIcon(512)],
  ['icon-maskable-512.png', renderIcon(512, { maskable: true })],
  ['badge-96.png', renderIcon(96, { maskable: true })],
  ['icon.svg', Buffer.from(svgIcon(), 'utf8')],
];

for (const [name, data] of outputs) {
  writeFileSync(join(OUT_DIR, name), data);
  process.stdout.write(`${name} (${data.length} bytes)\n`);
}
