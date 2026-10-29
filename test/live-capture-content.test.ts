import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { blankCapture, pngDistinctColors } from "../scripts/live/capture-content";

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

test("a uniform or near-uniform window frame is blank", () => {
  expect(blankCapture(png(40, 30, () => [255, 255, 255, 255]))).toBe(true);
  // A frame with a transparent rounded corner is still blank.
  expect(blankCapture(png(40, 30, (x, y) => x + y < 3 ? [0, 0, 0, 0] : [255, 255, 255, 255]))).toBe(true);
});

test("rendered content with text-like detail is not blank", () => {
  const page = png(40, 30, (x, y) => (y > 5 && y < 9 && x % 3) ? [x * 6, y * 8, 40, 255] : [250, 250, 250, 255]);
  expect(pngDistinctColors(page, 64)).toBeGreaterThan(16);
  expect(blankCapture(page)).toBe(false);
});

test("unsupported or corrupt captures are refused rather than passed", () => {
  const bytes = png(4, 4, () => [1, 2, 3, 255]);
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1;
  expect(() => blankCapture(corrupt)).toThrow();
});
