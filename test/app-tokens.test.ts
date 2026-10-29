import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateTokensCss, generateTokensTs, mergeTokens, provisionalEntries, type LocalTokenFile, type TokenFile } from "../app/tokens-gen";
import { tmpDir } from "./helpers";

const ds = join(import.meta.dir, "../app/src/ds");
const read = (name: string) => readFileSync(join(ds, name), "utf8");
const tokens = JSON.parse(read("tokens.json")) as TokenFile;
const local = JSON.parse(read("tokens.local.json")) as LocalTokenFile;
const sync = (args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/ds-sync.ts"), ...args], { stdout: "pipe", stderr: "pipe" });

test("generated token CSS equals the committed tokens.css", () => {
  expect(generateTokensCss(mergeTokens(tokens, local))).toBe(read("tokens.css"));
});

test("generated tokens.ts equals the committed file", () => {
  const ts = generateTokensTs(mergeTokens(tokens, local));
  expect(ts).toBe(read("tokens.ts"));
  expect(ts).toContain('"surface-page"');
});

test("a provisional token that the design system now has fails the merge", () => {
  const ink = { name: "ink", value: { light: "#000", dark: "#fff" }, usage: "x", provisional: "x" };
  expect(() => mergeTokens(tokens, { color: { tokens: [ink] } })).toThrow("ink is now in the design system");
});

test("provisional tokens are appended to their group", () => {
  const term = { name: "terminal-ground", value: { light: "#09090b", dark: "#09090b" }, usage: "Session view ground.", provisional: "until the design system adds a terminal group" };
  const merged = mergeTokens(tokens, { color: { tokens: [term] } });
  expect(merged.color.tokens.at(-1)?.name).toBe("terminal-ground");
  expect(generateTokensCss(merged)).toContain("--terminal-ground: #09090b;");
  expect(provisionalEntries({ color: { tokens: [term] } })).toEqual([{ group: "color", name: "terminal-ground", provisional: term.provisional }]);
});

test("provisional entries are listed", () => {
  const entries = provisionalEntries(local);
  if (entries.length) console.info("Provisional design tokens still pending in the design system:", entries);
  // The Tasks, Dispatch, Dispatcher, app-frame chrome, command menu, file viewer, session and activity bar board values, until the design system carries them. Each entry names its board.
  expect(entries.map(entry => entry.name)).toEqual(["ink-on-fill", "space-3.5", "space-7", "space-10", "radius-card", "radius-xs", "radius-4", "radius-5", "radius-2", "radius-7", "size-10", "size-14", "size-15", "size-21", "size-34", "size-52", "size-272", "size-1240", "size-3", "size-4", "size-5", "size-84", "size-420", "size-neg-6", "size-10.5", "size-12.5", "size-440", "size-72", "size-220", "size-140", "size-110", "size-9", "size-236", "count-badge", "match-strong", "session-title", "plugin-section", "tray-count"]);
  expect(entries.every(entry => entry.provisional.length > 20)).toBe(true);
});

test("ds-sync rejects an export missing a dark value and writes nothing", () => {
  const out = tmpDir();
  cpSync(ds, out, { recursive: true });
  const bad = structuredClone(tokens) as unknown as { color: { tokens: { value: Record<string, string> }[] } };
  delete bad.color.tokens[0]!.value.dark;
  const file = join(tmpDir(), "export.json");
  writeFileSync(file, JSON.stringify(bad));
  const result = sync([file, "--out", out]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("color.tokens.0.value.dark");
  expect(readFileSync(join(out, "tokens.json"), "utf8")).toBe(read("tokens.json"));
});

test("ds-sync writes tokens and reports changes", () => {
  const out = tmpDir();
  mkdirSync(out, { recursive: true });
  cpSync(ds, out, { recursive: true });
  const next = structuredClone(tokens);
  next.color.tokens.find(t => t.name === "ink")!.value.light = "#111111";
  const file = join(tmpDir(), "export.json");
  writeFileSync(file, JSON.stringify(next));
  const result = sync([file, "--out", out]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("changed: ink");
  expect(JSON.parse(readFileSync(join(out, "tokens.json"), "utf8")).color.tokens.find((t: { name: string }) => t.name === "ink").value.light).toBe("#111111");
  expect(readFileSync(join(out, "tokens.css"), "utf8")).toContain("--ink: #111111;");
  expect(readFileSync(join(out, "tokens.ts"), "utf8")).toContain("#111111");
});

test("app CSS only uses token variables that exist", () => {
  const defined = new Set([...read("tokens.css").matchAll(/--([a-z0-9-]+(?:\\\.[0-9]+)?):/g)].map(m => m[1]));
  const css = read("components.css") + readFileSync(join(import.meta.dir, "../app/src/styles.css"), "utf8");
  const used = new Set([...css.matchAll(/var\(--((?:space|radius|type|font)-[a-z0-9-]+(?:\\\.[0-9]+)?)[,)]/g)].map(m => m[1]));
  expect([...used].filter(name => !defined.has(name))).toEqual([]);
});

test('control, motion, shadow and layer tokens are generated from explicit groups', () => {
 for(const group of ['size','motion','shadow','layer'] as const) expect(tokens[group]?.tokens.length).toBeGreaterThan(0);
 expect(generateTokensCss(tokens)).toContain('--space-2\\.5: 10px;');
});
function luminance(hex:string) {const rgb=hex.match(/[0-9a-f]{2}/gi)!.map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return rgb[0]!*.2126+rgb[1]!*.7152+rgb[2]!*.0722;}
test('status badges use readable semantic foreground and background pairs in both themes',()=>{
 const css=readFileSync(join(import.meta.dir,'../app/src/styles.css'),'utf8');
 expect(css).toMatch(/\.pc-rail__badge--warn\{background:var\(--warn-bg\);color:var\(--warn-fg\)\}/);
 for(const tone of ['good','warn','bad','info'])for(const theme of ['light','dark'] as const){const fg=luminance(tokens.color.tokens.find(t=>t.name===`${tone}-fg`)!.value[theme]);const bg=luminance(tokens.color.tokens.find(t=>t.name===`${tone}-bg`)!.value[theme]);expect((Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)).toBeGreaterThanOrEqual(4.5);}
});

test('secondary text remains readable on tinted row surfaces',()=>{
 for(const theme of ['light','dark'] as const){const fg=luminance(tokens.color.tokens.find(t=>t.name==='ink-secondary')!.value[theme]);const bg=luminance(tokens.color.tokens.find(t=>t.name==='surface-lane')!.value[theme]);expect((Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)).toBeGreaterThanOrEqual(4.5);}
 const css=readFileSync(join(import.meta.dir,'../app/src/styles.css'),'utf8');expect(css).toMatch(/\.pc-repo-chip\{[^}]*color:var\(--ink-secondary\)/);
});

test('button shortcuts inherit the action contrast pair without a conflicting badge surface',()=>{
 const css=read('components.css');
 expect(css).toMatch(/\.pc-btn \.pc-kbd\{[^}]*background:transparent[^}]*color:inherit/);
 const tray=readFileSync(join(import.meta.dir,'../app/src/tray/tray.css'),'utf8');
 expect(tray).not.toMatch(/\.tray-footer \.pc-kbd\{[^}]*opacity:/);
 for(const theme of ['light','dark'] as const){const fg=luminance(tokens.color.tokens.find(t=>t.name==='ink-on-ink')!.value[theme]);const bg=luminance(tokens.color.tokens.find(t=>t.name==='ink')!.value[theme]);expect((Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)).toBeGreaterThanOrEqual(4.5);}
});


test('button theme backgrounds change immediately rather than transitioning stale native colors', () => {
 const css = read('components.css');
 expect(css).toContain('transition:opacity var(--motion-fast) var(--motion-ease)');
 expect(css).not.toContain('transition:background-color var(--motion-fast) var(--motion-ease),opacity');
});

test("a provisional type style the design system now has is rejected", () => {
  const known = tokens.type.groups[0]!.styles[0]!;
  const style = { ...known, provisional: "until the design system adds it" };
  expect(() => mergeTokens(tokens, { type: { styles: [style] } })).toThrow(`type-${known.name} is now in the design system`);
  const merged = mergeTokens(tokens, { type: { styles: [{ ...known, name: "count-badge-test", provisional: "x" }] } });
  expect(generateTokensCss(merged)).toContain("--type-count-badge-test-size:");
});
