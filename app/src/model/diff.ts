export interface DiffLine { text: string; kind: "added" | "removed" | "hunk" | "context" | "meta" }
export interface DiffFile { path: string; added: number; removed: number; binary: boolean; lines: DiffLine[] }
function pathName(path: string): string {
  let decoded = path;
  if (path.startsWith('"')) { try { decoded = JSON.parse(path); } catch { /* retain Git's quoted name */ } }
  return decoded.replace(/^[ab]\//, "");
}
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined, inHunk = false;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git ("(?:[^"\\]|\\.)*"|.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(line);
      file = { path: pathName(match?.[2] ?? line.slice(11)), added: 0, removed: 0, binary: false, lines: [] };
      files.push(file); inHunk = false; continue;
    }
    if (!file) continue;
    if (!inHunk && line.startsWith("+++ ") && line.slice(4) !== "/dev/null") file.path = pathName(line.slice(4));
    if (line.startsWith("rename to ")) file.path = pathName(line.slice(10));
    if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
    let kind: DiffLine["kind"] = "meta";
    if (line.startsWith("@@")) { inHunk = true; kind = "hunk"; }
    else if (inHunk && line.startsWith("+")) { kind = "added"; file.added++; }
    else if (inHunk && line.startsWith("-")) { kind = "removed"; file.removed++; }
    else if (inHunk && line.startsWith(" ")) kind = "context";
    file.lines.push({ text: line, kind });
  }
  return files;
}
