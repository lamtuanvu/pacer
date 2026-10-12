export type BlockStyle = "md" | "hash";

const MARKS = {
  md: ["<!-- >>> pacer >>> -->", "<!-- <<< pacer <<< -->"],
  hash: ["# >>> pacer >>>", "# <<< pacer <<<"],
} as const;

export function blockText(body: string, style: BlockStyle): string {
  const [open, close] = MARKS[style];
  return `${open}\n${body.replace(/\n+$/, "")}\n${close}\n`;
}

function findBlock(text: string, style: BlockStyle): { start: number; end: number } | null {
  const [open, close] = MARKS[style];
  const start = text.indexOf(open);
  if (start === -1) return null;
  const closing = text.indexOf(close, start);
  if (closing === -1) throw new Error(`unmatched open marker: ${open}`);
  let end = closing + close.length;
  if (text[end] === "\n") end++;
  return { start, end };
}

export function hasBlock(text: string, style: BlockStyle): boolean {
  return findBlock(text, style) !== null;
}

export function upsertBlock(text: string, body: string, style: BlockStyle): string {
  const block = blockText(body, style);
  const found = findBlock(text, style);
  if (found) return text.slice(0, found.start) + block + text.slice(found.end);
  if (text === "") return block;
  return text + (text.endsWith("\n") ? "\n" : "\n\n") + block;
}

export function removeBlock(text: string, style: BlockStyle): string {
  const found = findBlock(text, style);
  if (!found) return text;
  const before = text.slice(0, found.start);
  const rest = text.slice(found.end);
  if (rest === "" && before.endsWith("\n\n")) return before.slice(0, -1);
  return before + rest;
}
