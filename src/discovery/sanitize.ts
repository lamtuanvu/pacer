// C0/C1 controls, zero-width and bidi controls, line/paragraph separators and the BOM.
const STRIP = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** SEC-16: discovered (and advertised) text is cleaned and bounded by UTF-8 bytes; null if nothing is left. */
export function sanitizeText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const chars = Array.from(raw.replace(STRIP, "").trim());
  while (chars.length && Buffer.byteLength(chars.join(""), "utf8") > max) chars.pop();
  const s = chars.join("").trim();
  return s ? s : null;
}
