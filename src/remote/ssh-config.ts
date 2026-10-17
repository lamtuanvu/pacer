import { globSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** SSH words support quoting, escapes and comments; never evaluate shell text. */
function words(line: string): string[] {
  const result: string[] = [];
  let word = "", quote = "", escaped = false;
  for (const char of line) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "#") break;
    if (/\s/.test(char)) { if (word) result.push(word); word = ""; }
    else word += char;
  }
  if (word) result.push(word);
  return result;
}

/** Read concrete aliases in discovery order, following at most eight Includes. */
export function sshAliases(home: string, readFile = readFileSync): string[] {
  const base = join(home, ".ssh"), aliases = new Set<string>(), active = new Set<string>();
  const visit = (file: string, depth: number) => {
    file = resolve(file);
    if (depth > 8 || active.has(file)) return;
    let text: string;
    try { text = readFile(file, "utf8"); } catch { return; }
    active.add(file);
    try {
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(Host|Include)(?:\s*=\s*|\s+)(.*)$/i.exec(line);
        if (!match) continue;
        const values = words(match[2]);
        if (match[1].toLowerCase() === "host") {
          for (const value of values) if (!/[*?!]/.test(value)) aliases.add(value);
        } else for (const value of values) {
          const expanded = value.startsWith("~/") ? join(home, value.slice(2)) : isAbsolute(value) ? value : join(base, value);
          if (!/[*?\[]/.test(expanded)) visit(expanded, depth + 1);
          else {
            let files: string[];
            try { files = globSync(expanded).sort(); } catch { continue; }
            for (const included of files) visit(included, depth + 1);
          }
        }
      }
    } finally { active.delete(file); }
  };
  visit(join(base, "config"), 0);
  return [...aliases];
}
