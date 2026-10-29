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
export function sshSuggestions(home: string, readFile = readFileSync): { name: string; host: string }[] {
  const base = join(home, ".ssh"), aliases = new Set<string>(), blocks: { patterns: string[]; host?: string }[] = [], active = new Set<string>();
  let block: { patterns: string[]; host?: string } | undefined;
  const visit = (file: string, depth: number) => {
    file = resolve(file);
    if (depth > 8 || active.has(file)) return;
    let text: string;
    try { text = readFile(file, "utf8"); } catch { return; }
    active.add(file);
    try {
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(Host|HostName|Match|Include)(?:\s*=\s*|\s+)(.*)$/i.exec(line);
        if (!match) continue;
        const values = words(match[2]);
        if (match[1].toLowerCase() === "hostname") {
          if (block && !block.host && values[0]) block.host = values[0];
        } else if (match[1].toLowerCase() === "match") {
          block = undefined;
        } else if (match[1].toLowerCase() === "host") {
          block = { patterns: values }; blocks.push(block);
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
  const matches = (pattern: string, name: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i").test(name);
  return [...aliases].map(name => {
    const entry = blocks.find(block => block.host && block.patterns.some(pattern => !pattern.startsWith("!") && matches(pattern, name)) && !block.patterns.some(pattern => pattern.startsWith("!") && matches(pattern.slice(1), name)));
    return { name, host: entry?.host?.replace(/%h/g, name) ?? name };
  });
}

/** Compatibility wrapper for clients that only need alias names. */
export function sshAliases(home: string, readFile = readFileSync): string[] {
  return sshSuggestions(home, readFile).map(alias => alias.name);
}
