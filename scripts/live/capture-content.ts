/** Harness check that a native capture shows rendered content, not a blank frame. */
import { inflateSync } from "node:zlib";
import { validatePng } from "../../src/desktop/png";

/** Distinct pixel values in an 8-bit RGB or RGBA non-interlaced PNG, counted up to `limit`. */
export function pngDistinctColors(input: Uint8Array, limit = 64): number {
  const { width, height } = validatePng(input);
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const data: Buffer[] = [];
  let depth = 0, color = 0, interlace = 0;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { depth = payload[8]; color = payload[9]; interlace = payload[12]; }
    if (type === "IDAT") data.push(payload);
    offset += 12 + length;
  }
  if (depth !== 8 || interlace || (color !== 2 && color !== 6)) throw Error("Unsupported capture format for the content check");
  const channels = color === 6 ? 4 : 3, stride = width * channels;
  const raw = inflateSync(Buffer.concat(data));
  let previous = Buffer.alloc(stride);
  const seen = new Set<string>();
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0, up = previous[i], corner = i >= channels ? previous[i - channels] : 0;
      const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      const predictor = [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : corner][filter];
      row[i] = (row[i] + predictor) & 255;
    }
    for (let x = 0; x < stride && seen.size < limit; x += channels) seen.add(row.subarray(x, x + channels).toString("hex"));
    if (seen.size >= limit) return seen.size;
    previous = row;
  }
  return seen.size;
}

/** A frame with almost no distinct colors has no rendered text or controls. */
export function blankCapture(input: Uint8Array): boolean {
  return pngDistinctColors(input, 16) < 16;
}
