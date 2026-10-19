// Copies a tokens.json exported from the pacer design system into the app and regenerates tokens.css and tokens.ts.
// Usage: bun scripts/ds-sync.ts <exported tokens.json> [--out <dir>]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateTokensCss, generateTokensTs, readTokens, tokenFileSchema, type TokenFile } from "../app/tokens-gen";

function values(tokens: TokenFile): Map<string, string> {
  return new Map([
    ...tokens.color.tokens.map(t => [t.name, JSON.stringify(t.value)] as const),
    ...[...tokens.spacing.tokens, ...tokens.radius.tokens, ...tokens.size.tokens, ...tokens.shadow.tokens, ...tokens.layer.tokens, ...tokens.motion.tokens].map(t => [t.name, t.value] as const),
  ]);
}

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : join(import.meta.dir, "../app/src/ds");
const file = args.find((arg, i) => !arg.startsWith("--") && (outAt < 0 || i !== outAt + 1));
if (!file || !out) {
  console.error("Usage: bun scripts/ds-sync.ts <exported tokens.json> [--out <dir>]");
  process.exit(1);
}
const parsed = tokenFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
if (!parsed.success) {
  for (const issue of parsed.error.issues) console.error(`${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}
const before = values(tokenFileSchema.parse(JSON.parse(readFileSync(join(out, "tokens.json"), "utf8"))));
const after = values(parsed.data);
writeFileSync(join(out, "tokens.json"), `${JSON.stringify(parsed.data, null, 2)}\n`);
const merged = readTokens(out);
writeFileSync(join(out, "tokens.css"), generateTokensCss(merged));
writeFileSync(join(out, "tokens.ts"), generateTokensTs(merged));
const lines = [
  ...[...after.keys()].filter(k => !before.has(k)).map(k => `added: ${k}`),
  ...[...before.keys()].filter(k => !after.has(k)).map(k => `removed: ${k}`),
  ...[...after].filter(([k, v]) => before.has(k) && before.get(k) !== v).map(([k]) => `changed: ${k}`),
];
console.log(lines.length ? lines.join("\n") : "no token changes");
