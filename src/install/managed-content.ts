import type { UndoOp } from "./manifest";
import { getMember, parseJsonc } from "./jsonc";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** Project only installer-owned pieces; unrelated settings are never ownership evidence. */
export function managedContent(text: string, ops: UndoOp[]): string {
  if (!ops.length) return text;
  const pieces = ops.map(op => {
    switch (op.kind) {
      case "block": {
        const open = op.style === "md" ? "<!-- >>> pacer >>> -->" : "# >>> pacer >>>";
        const close = op.style === "md" ? "<!-- <<< pacer <<< -->" : "# <<< pacer <<<";
        const starts = text.split(open).length - 1, ends = text.split(close).length - 1;
        if (!starts && !ends) return null;
        if (starts !== 1 || ends !== 1 || text.indexOf(close) < text.indexOf(open)) throw Error("ambiguous managed block");
        return text.slice(text.indexOf(open), text.indexOf(close) + close.length);
      }
      case "json-key": return parseJsonc(text)[op.key] ?? null;
      case "json-member": return getMember(text, op.path) ?? null;
      case "toml-table": {
        const doc = Bun.TOML.parse(text) as Record<string, any>;
        return op.table.split(".").reduce((value, key) => value?.[key], doc) ?? null;
      }
      case "hooks": {
        const doc = parseJsonc(text), result: unknown[] = [];
        for (const [event, entries] of Object.entries(doc.hooks ?? {})) {
          if (!Array.isArray(entries)) throw Error("invalid hooks");
          for (const entry of entries) {
            if (op.format === "cursor") {
              if (op.commands.includes(entry.command)) result.push({ event, hook: entry });
            } else {
              if (!Array.isArray(entry.hooks)) throw Error("invalid hook group");
              const hooks = entry.hooks.filter((hook: any) => op.commands.includes(hook.command));
              if (hooks.length) result.push({ event, group: { ...entry, hooks } });
            }
          }
        }
        return result;
      }
    }
  });
  return JSON.stringify(canonical(pieces));
}
