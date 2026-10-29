import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { blankCapture, captureContent, captureProblem, captureTheme, pngDistinctColors } from "../scripts/live/capture-content";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function chunk(type: string, payload: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + payload.length);
  return out;
}
// RGBA 8-bit with a different filter on each row, so unfiltering is exercised.
function png(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const raw: number[] = [];
  let previous = new Array(width * 4).fill(0);
  for (let y = 0; y < height; y++) {
    const row = Array.from({ length: width }, (_, x) => pixel(x, y)).flat();
    const filter = y % 5;
    raw.push(filter);
    row.forEach((value, i) => {
      const left = i >= 4 ? row[i - 4] : 0, up = previous[i], corner = i >= 4 ? previous[i - 4] : 0;
      const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      const predictor = [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : corner][filter];
      raw.push((value - predictor) & 255);
    });
    previous = row;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from(raw))), chunk("IEND", Buffer.alloc(0))]);
}

// A 1120x760 window like the native captures: title-bar traffic lights in the
// top-left with antialiased edges, over the given page.
const [W, H] = [1120, 760];
const lights = [[255, 95, 87], [254, 188, 46], [40, 200, 64]], bar = [236, 236, 236, 255];
// Full-size frames are written straight into a buffer, unfiltered, to keep the test fast.
function fastPng(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0, at = 0; y < height; y++) {
    raw[at++] = 0;
    for (let x = 0; x < width; x++) for (const value of pixel(x, y)) raw[at++] = value;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function windowFrame(page: (x: number, y: number) => number[]) {
  return fastPng(W, H, (x, y) => {
    if (y >= 28) return page(x, y);
    for (const [index, color] of lights.entries()) {
      const distance = Math.hypot(x - (20 + index * 20), y - 14);
      if (distance < 7) {
        const edge = Math.max(0, Math.min(1, 7 - distance));
        return [...color.map(value => Math.round(value * edge + 236 * (1 - edge))), 255];
      }
    }
    return bar;
  });
}
// Text-like runs of antialiased glyph shades on a page background.
const text = (background: number[], ink: number[]) => {
  const plain = [...background, 255];
  return (x: number, y: number) => {
    if (y % 40 > 24 || y % 40 < 12 || x < 60 || x > 900 || x % 7 === 0) return plain;
    const mix = ((x * 13 + y * 7) % 97) / 96;
    return [...background.map((value, i) => Math.round(value * mix + ink[i] * (1 - mix))), 255];
  };
};

const [clear, white] = [[0, 0, 0, 0], [255, 255, 255, 255]];
test("a blank page under the title-bar controls is blank, as in the real failure", () => {
  // The real blank Settings frame: a transparent page below the traffic lights.
  const transparent = windowFrame(() => clear);
  // The old whole-frame colour count let this frame through.
  expect(pngDistinctColors(transparent, 256)).toBeGreaterThan(16);
  expect(blankCapture(transparent)).toBe(true);
  expect(captureTheme(transparent)).toBeNull();
  expect(captureProblem(transparent, "dark")).toBe("blank page");
  // A uniform painted page with no content is blank too.
  const painted = windowFrame(() => white);
  expect(pngDistinctColors(painted, 256)).toBeGreaterThan(16);
  expect(blankCapture(painted)).toBe(true);
});

test("a rendered page is not blank and reports its theme", () => {
  const light = windowFrame(text([250, 250, 250], [30, 30, 30]));
  const dark = windowFrame(text([18, 18, 20], [230, 230, 230]));
  expect(captureContent(light).colors).toBeGreaterThanOrEqual(64);
  expect(blankCapture(light)).toBe(false);
  expect(blankCapture(dark)).toBe(false);
  expect(captureTheme(light)).toBe("light");
  expect(captureTheme(dark)).toBe("dark");
  expect(captureProblem(light, "light")).toBeNull();
  expect(captureProblem(dark, "dark")).toBeNull();
  // A light frame recorded as dark evidence is refused.
  expect(captureProblem(light, "dark")).toBe("light theme shown, expected dark");
});

test("unsupported or corrupt captures are refused rather than passed", () => {
  const bytes = png(4, 4, () => [1, 2, 3, 255]);
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1;
  expect(() => blankCapture(corrupt)).toThrow();
});
