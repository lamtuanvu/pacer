const GLYPHS = { failed: "✕", waiting: "◐", done: "✓" } as const;
/** Decorative only: callers always print the status in words next to it. */
export function StatusGlyph({ kind }: { kind: keyof typeof GLYPHS }) {
  return <span className={`pc-glyph pc-glyph--${kind}`} aria-hidden="true">{GLYPHS[kind]}</span>;
}
