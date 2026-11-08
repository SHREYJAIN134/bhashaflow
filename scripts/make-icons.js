// Generates the extension icons (amber rounded square with a dark "B") as PNG files using only Node's zlib.
// No image dependency and no binary assets in the repository: `npm run build` writes them into extension/dist/icons.
import { deflateSync, crc32 } from 'node:zlib';

const AMBER = [0xf5, 0xa5, 0x24, 0xff];
const INK = [0x1a, 0x12, 0x03, 0xff];

// 5x7 bitmap of the letter B
const GLYPH_B = [
  '1111.',
  '1...1',
  '1...1',
  '1111.',
  '1...1',
  '1...1',
  '1111.',
];

/** RGBA pixels for a size x size icon. */
export function iconPixels(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const radius = size * 0.22;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  const scale = Math.max(1, Math.floor((size * 0.6) / 7));
  const gw = 5 * scale;
  const gh = 7 * scale;
  const gx = Math.floor((size - gw) / 2);
  const gy = Math.floor((size - gh) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x, y)) continue;
      let color = AMBER;
      const lx = x - gx;
      const ly = y - gy;
      if (lx >= 0 && ly >= 0 && lx < gw && ly < gh && GLYPH_B[Math.floor(ly / scale)][Math.floor(lx / scale)] === '1') color = INK;
      px.set(color, (y * size + x) * 4);
    }
  }
  return px;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A complete PNG file (8-bit RGBA, no interlace) for a size x size icon. */
export function makeIconPng(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const px = iconPixels(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const ICON_SIZES = [16, 32, 48, 128];
