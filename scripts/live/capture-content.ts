/** Harness check that a native capture shows rendered content, not a blank frame. */
import { inflateSync } from "node:zlib";
import { validatePng } from "../../src/desktop/png";

/** Window chrome excluded from the content check: the title bar and its controls, and the rounded edges. */
export const CAPTURE_TITLE_BAR = 52;
const CAPTURE_EDGE = 8;
// Real rendered pages have about 850-2900 colours below the title bar; a blank page has one or two.
const CONTENT_COLORS = 64;

/** Unfiltered rows of an 8-bit RGB or RGBA non-interlaced PNG. */
function decodePng(input: Uint8Array) {
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
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    if (filter > 4) throw Error("Corrupt capture filter");
    if (filter) for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0, up = previous[i];
      let predictor: number;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else {
        const corner = i >= channels ? previous[i - channels] : 0;
        const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      row[i] = (row[i] + predictor) & 255;
    }
    rows.push(row);
    previous = row;
  }
  return { width, height, channels, rows };
}

/** Distinct pixel values in the whole frame, counted up to `limit`. */
export function pngDistinctColors(input: Uint8Array, limit = 64): number {
  const { channels, rows } = decodePng(input);
  const seen = new Set<string>();
  for (const row of rows) {
    for (let x = 0; x < row.length && seen.size < limit; x += channels) seen.add(row.subarray(x, x + channels).toString("hex"));
    if (seen.size >= limit) break;
  }
  return seen.size;
}

/** Opaque page pixels below the title bar: distinct colours (up to `limit`) and mean luminance. */
export function captureContent(input: Uint8Array, limit = CONTENT_COLORS) {
  const { width, height, channels, rows } = decodePng(input);
  const seen = new Set<number>();
  let luminance = 0, opaque = 0;
  for (let y = CAPTURE_TITLE_BAR; y < height - CAPTURE_EDGE; y++) {
    const row = rows[y];
    for (let x = CAPTURE_EDGE; x < width - CAPTURE_EDGE; x++) {
      const at = x * channels;
      if (channels === 4 && row[at + 3] < 255) continue;
      if (seen.size < limit) seen.add(row[at] << 16 | row[at + 1] << 8 | row[at + 2]);
      luminance += 0.2126 * row[at] + 0.7152 * row[at + 1] + 0.0722 * row[at + 2];
      opaque++;
    }
  }
  return { colors: seen.size, luminance: opaque ? luminance / opaque : null };
}

/** A page with almost no distinct colours below the title bar has no rendered text or controls. */
export function blankCapture(input: Uint8Array): boolean {
  return captureContent(input).colors < CONTENT_COLORS;
}

/** The theme a rendered page shows, from its mean luminance; null when nothing opaque was rendered. */
export function captureTheme(input: Uint8Array): "light" | "dark" | null {
  const { luminance } = captureContent(input);
  return luminance === null ? null : luminance >= 128 ? "light" : "dark";
}

/** Why a capture cannot be evidence for the expected theme, or null when it can. */
export function captureProblem(input: Uint8Array, theme: "light" | "dark"): string | null {
  if (blankCapture(input)) return "blank page";
  const shown = captureTheme(input);
  return shown === theme ? null : `${shown ?? "no"} theme shown, expected ${theme}`;
}
