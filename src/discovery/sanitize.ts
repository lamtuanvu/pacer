// Controls, format characters (zero-width, bidi, soft hyphen, invisible operators, the BOM), line/paragraph separators
// and the whole tag block. The zero-width joiner stays so joined emoji keep their meaning (N1).
const STRIP = /(?!\u200d)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{E0000}-\u{E007F}]/gu;

/** SEC-16: discovered (and advertised) text is cleaned and bounded by UTF-8 bytes; null if nothing is left. */
export function sanitizeText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const chars = Array.from(raw.replace(STRIP, "").trim());
  while (chars.length && Buffer.byteLength(chars.join(""), "utf8") > max) chars.pop();
  const s = chars.join("").trim();
  return s ? s : null;
}
