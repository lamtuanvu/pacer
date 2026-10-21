import { inflateSync } from "node:zlib";
import { CoreError } from "../core/errors";
export const PNG_MAX_BYTES = 16 * 1024 * 1024;
export const PNG_MAX_DECODED_BYTES = 128 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** Validate complete chunks, CRCs, zlib data and scanline framing before accepting evidence. */
export function validatePng(input: Uint8Array): { width: number; height: number } {
  const bad = (): never => { throw new CoreError("invalid_input", "Invalid or unsupported capture PNG"); };
  if (input.byteLength > PNG_MAX_BYTES) throw new CoreError("too_large", "Capture exceeds 16 MiB");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) bad();
  let width = 0, height = 0, depth = 0, color = -1, interlace = 0;
  let ended = false, seenData = false, dataEnded = false, palette = false;
  const data: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) bad();
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) bad();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) bad();
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) bad();
    const payload = bytes.subarray(offset + 8, end - 4);
    if (!width && type !== "IHDR") bad();
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13 || width) bad();
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      depth = payload[8]; color = payload[9]; interlace = payload[12];
      if (!width || !height || width > 16384 || height > 16384 || payload[10] !== 0 || payload[11] !== 0 || interlace > 1) bad();
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth)) bad();
    } else if (type === "PLTE") {
      if (seenData || palette || !length || length % 3 || length > 768 || color === 0 || color === 4) bad();
      palette = true;
    } else if (type === "IDAT") {
      if (dataEnded || (color === 3 && !palette)) bad();
      seenData = true; data.push(payload);
    } else if (type === "IEND") {
      if (length || !seenData || end !== bytes.length) bad();
      ended = true;
    } else {
      if (type[0] === type[0].toUpperCase()) bad();
      if (seenData) dataEnded = true;
    }
    offset = end;
  }
  if (!ended) bad();
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const rows: Array<{ bytes: number; count: number }> = [];
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const count = Math.max(0, Math.ceil((height - y) / dy));
    if (!columns || !count) continue;
    const rowBytes = Math.ceil(columns * channels * depth / 8);
    rows.push({ bytes: rowBytes, count }); expected += (rowBytes + 1) * count;
  }
  if (expected > PNG_MAX_DECODED_BYTES) throw new CoreError("too_large", "Decoded capture exceeds 128 MiB");
  let decoded: Buffer;
  try { decoded = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 }); }
  catch { return bad(); }
  if (decoded.length !== expected) bad();
  let offset = 0;
  for (const row of rows) for (let n = 0; n < row.count; n++) {
    if (decoded[offset] > 4) bad();
    offset += row.bytes + 1;
  }
  return { width, height };
}
