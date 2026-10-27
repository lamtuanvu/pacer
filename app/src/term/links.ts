export type TerminalLink =
  | { kind: "web"; url: string }
  | { kind: "file"; reference: string; line?: number; column?: number };

export interface TerminalLinkMatch { start: number; end: number; target: TerminalLink }
export interface WrappedLine { text: string; wrapped: boolean; cells?: number[]; endCells?: number[] }
export interface WrappedFileLink { start: { x: number; y: number }; end: { x: number; y: number }; target: Extract<TerminalLink, { kind: "file" }> }
export function findWrappedFileLinks(lines: WrappedLine[], row: number): WrappedFileLink[] {
  if (row < 0 || row >= lines.length) return [];
  let first = row;
  while (first > 0 && lines[first]?.wrapped) first--;
  let last = row;
  while (last + 1 < lines.length && lines[last + 1]?.wrapped) last++;
  const joined = lines.slice(first, last + 1).map(line => line.text).join("");
  const at = (offset: number, end = false) => {
    for (let line = first; line <= last; line++) {
      const length = lines[line]!.text.length;
      if (offset < length || line === last) return { x: (end ? lines[line]?.endCells?.[offset] : undefined) ?? lines[line]?.cells?.[offset] ?? offset + 1, y: line + 1 };
      offset -= length;
    }
    return { x: 1, y: first + 1 };
  };
  return findTerminalLinks(joined).flatMap(match => {
    if (match.target.kind !== "file") return [];
    const start = at(match.start), end = at(match.end - 1, true);
    return start.y <= row + 1 && end.y >= row + 1 ? [{ start, end, target: match.target }] : [];
  });
}
export function shouldActivateTerminalLink(controlling: boolean, event: {metaKey:boolean;ctrlKey:boolean}): boolean {
  return !controlling || event.metaKey || event.ctrlKey;
}

const CANDIDATE = /https?:\/\/[^\s<>"'`]+|`[^`\n]+`|"[^"\n]+"|(?:\.{1,2}\/|\/|[A-Za-z\d_.-]+\/)[^\s<>"'`]+|[A-Za-z\d_.-]+\.[A-Za-z\d_-]+(?::\d+(?::\d+)?)?/g;

export function findTerminalLinks(line: string): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  for (const match of line.matchAll(CANDIDATE)) {
    const raw = trimEnd(match[0]);
    const target = classifyTerminalLink(raw, false);
    if (target) matches.push({ start: match.index, end: match.index + raw.length, target });
  }
  return matches;
}

function trimEnd(value: string): string {
  let text = value.trim();
  while (/[.,;!?]$/.test(text)) text = text.slice(0, -1);
  while (text.endsWith(")") && (text.match(/\)/g)?.length ?? 0) > (text.match(/\(/g)?.length ?? 0)) text = text.slice(0, -1);
  return text;
}

export function classifyTerminalLink(raw: string, explicit: boolean): TerminalLink | null {
  const target = trimEnd(raw);
  if (!target || target.length > 4096 || /[\x00-\x1f\x7f]/.test(target)) return null;
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      return url.protocol === "http:" || url.protocol === "https:" ? { kind: "web", url: url.href } : null;
    } catch { return null; }
  }
  if (explicit && /^file:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (url.host && url.host !== "localhost") return null;
      return { kind: "file", reference: decodeURIComponent(url.pathname) };
    } catch { return null; }
  }
  let path = target;
  if ((path.startsWith("`") && path.endsWith("`")) || (path.startsWith('"') && path.endsWith('"'))) path = path.slice(1, -1);
  const location = /:(\d+)(?::(\d+))?$/.exec(path);
  if (location) path = path.slice(0, location.index);
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(path)) return null;
  if (!path || path.endsWith("/") || /[<>|*?]/.test(path)) return null;
  if (!path.includes("/") && !/^[^\s]+\.[A-Za-z\d_-]+$/.test(path)) return null;
  if (path.includes(" ") && !path.includes("/")) return null;
  const line = location ? Number(location[1]) : undefined;
  const column = location?.[2] ? Number(location[2]) : undefined;
  if ((line !== undefined && (!Number.isSafeInteger(line) || line < 1)) || (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) return null;
  return { kind: "file", reference: path, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}
