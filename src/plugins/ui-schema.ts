import { z } from "zod";

/** Closed icon vocabulary; the app maps each name to a design-system icon (a test fails on a gap). */
export const UI_ICONS = ["check-square", "list", "bell", "chart", "clock", "cog", "file", "folder", "git-branch", "key", "link", "shield", "tag", "terminal", "users", "zap", "plugin"] as const;
/** Routes a plugin may link to or receive as context; mirrors the app's route ids. */
export const UI_ROUTES = ["start", "overview", "review", "sessions", "terminal", "settings", "hosts", "add-executor", "setup"] as const;
export const UI_SURFACE_KINDS = ["activity", "panelTabs", "settings", "status"] as const;
export type UiSurfaceKind = (typeof UI_SURFACE_KINDS)[number];

export const UI_LIMITS = { activity: 2, panelTabs: 3, settings: 1, status: 1 } as const;
export const DOC_LIMITS = { bytes: 64 * 1024, nodes: 500, depth: 8, label: 80, text: 2000, code: 16 * 1024, keyValue: 50, list: 200, statusItemText: 24 } as const;

const surfaceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "id is 1-32 lowercase letters, digits and hyphens");
/** Manifest display text: cleaned like view text, so control and bidi characters never reach a client. */
const plain = (min: number, max: number) => z.string().transform(s => s.normalize("NFC").replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "")).pipe(z.string().min(min).max(max));
const title = plain(1, 40);
const taskIdText = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, "taskId uses letters, digits and . _ : -");
const view = z.string().min(1).max(64);
const icon = z.enum(UI_ICONS);
const unique = (items: { id: string }[]) => new Set(items.map(i => i.id)).size === items.length;

const secretLike = /key|token|secret|pass|pwd|cred|auth|bearer|private|cookie|session/i;

export const settingsFieldSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), title: plain(1, 80), description: plain(0, 200).optional(), default: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("string"), title: plain(1, 80), description: plain(0, 200).optional(), enum: z.array(plain(1, 80)).min(1).max(20).optional(), maxLength: z.number().int().min(1).max(2000).optional(), default: z.string().max(2000).optional() }).strict(),
  z.object({ type: z.literal("secretRef"), title: plain(1, 80), description: plain(0, 200).optional() }).strict(),
  z.object({ type: z.literal("integer"), title: plain(1, 80), description: plain(0, 200).optional(), minimum: z.number().int(), maximum: z.number().int(), default: z.number().int().optional() }).strict(),
  z.object({ type: z.literal("array"), items: z.object({ type: z.literal("string") }).strict(), title: plain(1, 80), description: plain(0, 200).optional(), maxItems: z.number().int().min(1).max(100) }).strict(),
  z.object({ type: z.literal("repos"), title: plain(1, 80), description: plain(0, 200).optional(), maxItems: z.number().int().min(1).max(100).optional() }).strict(),
]);
export type SettingsField = z.infer<typeof settingsFieldSchema>;

export const settingsSchemaSchema = z.object({ fields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/), settingsFieldSchema) }).strict()
  .superRefine((s, ctx) => {
    if (Object.keys(s.fields).length > 30) ctx.addIssue({ code: "custom", message: "a settings page has at most 30 fields" });
    for (const [name, f] of Object.entries(s.fields)) {
      if (f.type !== "secretRef" && f.type !== "boolean" && f.type !== "integer" && (secretLike.test(name) || secretLike.test(f.title)))
        ctx.addIssue({ code: "custom", path: ["fields", name], message: "a plain field cannot hold a key, token, secret or password; use a secretRef field" });
      if (f.type === "integer" && f.minimum > f.maximum) ctx.addIssue({ code: "custom", path: ["fields", name], message: "minimum exceeds maximum" });
    }
  });
export type SettingsSchema = z.infer<typeof settingsSchemaSchema>;

export const uiContributionSchema = z.object({
  activity: z.array(z.object({ id: surfaceId, title, icon, view }).strict()).max(UI_LIMITS.activity).default([]),
  panelTabs: z.array(z.object({ id: surfaceId, title, icon, view, context: z.enum(["global", "task"]).default("global") }).strict()).max(UI_LIMITS.panelTabs).default([]),
  settings: z.array(z.object({ id: surfaceId, title, schema: settingsSchemaSchema }).strict()).max(UI_LIMITS.settings).default([]),
  status: z.array(z.object({ id: surfaceId, title, view }).strict()).max(UI_LIMITS.status).default([]),
}).strict().superRefine((ui, ctx) => {
  for (const k of UI_SURFACE_KINDS) if (!unique(ui[k])) ctx.addIssue({ code: "custom", path: [k], message: "surface ids must be unique" });
});
export type UiContribution = z.infer<typeof uiContributionSchema>;

// ── View documents ────────────────────────────────────────────────────────────

const ZERO_WIDTH_AND_BIDI = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Plugin text is data: NFC, no control, zero-width or bidirectional-override characters. Newline and tab survive. */
export function cleanText(s: string): string {
  return s.normalize("NFC").replace(CONTROLS, "").replace(ZERO_WIDTH_AND_BIDI, "");
}
const text = (max: number, min = 0) => z.string().transform(cleanText).pipe(z.string().min(min).max(max));
const label = text(DOC_LIMITS.label, 1);
const tone = z.enum(["neutral", "info", "good", "warn", "bad"]);
const pct = z.number().min(0).max(100);
const to = z.object({ route: z.enum(UI_ROUTES), taskId: taskIdText.optional() }).strict();
const actionName = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const confirm = z.object({ title: label, body: text(DOC_LIMITS.text, 1) }).strict();

export type ViewNode =
  | { type: "section"; title?: string; children: ViewNode[] }
  | { type: "stack"; gap: "related" | "content"; children: ViewNode[] }
  | { type: "heading"; text: string; level: 2 | 3 }
  | { type: "text"; text: string; tone?: "muted" }
  | { type: "keyValue"; items: { label: string; value: string }[] }
  | { type: "list"; items: { title: string; subtitle?: string; status?: { label: string; tone: z.infer<typeof tone> }; action?: string }[]; empty: string }
  | { type: "status"; label: string; tone: z.infer<typeof tone> }
  | { type: "meter"; label: string; usedPct: number; pacePct?: number }
  | { type: "code"; text: string }
  | { type: "link"; label: string; to: { route: (typeof UI_ROUTES)[number]; taskId?: string } }
  | { type: "button"; label: string; action: string; variant: "secondary" | "quiet" | "danger"; confirm?: { title: string; body: string } }
  | { type: "checkbox"; label: string; name: string; checked: boolean; action: string }
  | { type: "empty"; title: string; body?: string };

const children = (): z.ZodType<ViewNode[]> => z.array(z.lazy(() => viewNodeSchema));
export const viewNodeSchema: z.ZodType<ViewNode> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("section"), title: label.optional(), children: children() }).strict(),
  z.object({ type: z.literal("stack"), gap: z.enum(["related", "content"]), children: children() }).strict(),
  z.object({ type: z.literal("heading"), text: label, level: z.union([z.literal(2), z.literal(3)]) }).strict(),
  z.object({ type: z.literal("text"), text: text(DOC_LIMITS.text), tone: z.literal("muted").optional() }).strict(),
  z.object({ type: z.literal("keyValue"), items: z.array(z.object({ label, value: text(DOC_LIMITS.label) }).strict()).max(DOC_LIMITS.keyValue) }).strict(),
  z.object({ type: z.literal("list"), empty: text(DOC_LIMITS.label), items: z.array(z.object({ title: text(120, 1), subtitle: text(200).optional(), status: z.object({ label, tone }).strict().optional(), action: actionName.optional() }).strict()).max(DOC_LIMITS.list) }).strict(),
  z.object({ type: z.literal("status"), label, tone }).strict(),
  z.object({ type: z.literal("meter"), label, usedPct: pct, pacePct: pct.optional() }).strict(),
  z.object({ type: z.literal("code"), text: text(DOC_LIMITS.code) }).strict(),
  z.object({ type: z.literal("link"), label, to }).strict(),
  z.object({ type: z.literal("button"), label, action: actionName, variant: z.enum(["secondary", "quiet", "danger"]), confirm: confirm.optional() }).strict(),
  z.object({ type: z.literal("checkbox"), label, name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), checked: z.boolean(), action: actionName }).strict(),
  z.object({ type: z.literal("empty"), title: label, body: text(DOC_LIMITS.text).optional() }).strict(),
]) as unknown as z.ZodType<ViewNode>);

export type ViewDocument = ViewNode;
export type ParsedDocument = { ok: true; document: ViewDocument } | { ok: false; error: string };

function measure(node: ViewNode, depth: number, acc: { nodes: number; deepest: number }): void {
  acc.nodes++; acc.deepest = Math.max(acc.deepest, depth);
  if ("children" in node) for (const c of node.children) measure(c, depth + 1, acc);
}

/** Validate and normalize a plugin's document. The error names the path, never the content (it may hold task data). */
export function parseViewDocument(raw: unknown): ParsedDocument {
  let size: number;
  try { size = new TextEncoder().encode(JSON.stringify(raw)).length; } catch { return { ok: false, error: "document is not serializable" }; }
  if (size > DOC_LIMITS.bytes) return { ok: false, error: `document exceeds ${DOC_LIMITS.bytes} bytes` };
  const parsed = viewNodeSchema.safeParse(raw);
  if (!parsed.success) { const i = parsed.error.issues[0]; return { ok: false, error: `${i?.path.join(".") || "document"}: ${i?.message ?? "invalid"}` }; }
  const acc = { nodes: 0, deepest: 0 };
  measure(parsed.data, 1, acc);
  if (acc.nodes > DOC_LIMITS.nodes) return { ok: false, error: `document has more than ${DOC_LIMITS.nodes} nodes` };
  if (acc.deepest > DOC_LIMITS.depth) return { ok: false, error: `document is deeper than ${DOC_LIMITS.depth} levels` };
  return { ok: true, document: parsed.data };
}

/** A status item's document is one `status` or `text` node (at most 24 characters), optionally wrapped in a button. */
export function parseStatusItemDocument(raw: unknown): ParsedDocument {
  const r = parseViewDocument(raw);
  if (!r.ok) return r;
  const d = r.document;
  if (d.type === "status") return d.label.length <= DOC_LIMITS.statusItemText ? r : { ok: false, error: "status item text is longer than 24 characters" };
  if (d.type === "text") return d.text.length <= DOC_LIMITS.statusItemText ? r : { ok: false, error: "status item text is longer than 24 characters" };
  if (d.type === "button") return d.label.length <= DOC_LIMITS.statusItemText ? r : { ok: false, error: "status item text is longer than 24 characters" };
  return { ok: false, error: "a status item is one status, text or button node" };
}

// ── Host methods ──────────────────────────────────────────────────────────────

const context = z.object({ route: z.enum(UI_ROUTES), taskId: taskIdText.optional(), theme: z.enum(["light", "dark"]) }).strict();
export const uiRenderParams = z.object({ surface: z.enum(["activity", "panelTab", "status"]), id: surfaceId, view, context }).strict();
export const uiRenderResult = z.object({ document: z.unknown(), ttlS: z.number().int().min(0).max(3600).optional() });
const scalar = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
export const uiActionParams = z.object({ surface: z.enum(["activity", "panelTab", "status"]), id: surfaceId, action: actionName, context, requestId: z.string().min(1).max(128), values: z.record(z.string().max(64), scalar).refine(v => Object.keys(v).length <= 20, "at most 20 values").optional() }).strict();
export const uiActionResult = z.object({ result: z.enum(["done", "refresh"]), message: text(200).optional() });
export const uiValidateParams = z.object({ id: surfaceId, values: z.record(z.string(), z.json()) }).strict();
export const uiValidateResult = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), errors: z.array(z.object({ path: text(200), message: text(200) })).max(50) })]);

/** Plugin → host notifications and the extension point that may send each. */
export const NOTIFICATIONS: Record<string, { point: string; params: z.ZodTypeAny }> = {
  "ui.invalidate": { point: "ui", params: z.object({ id: surfaceId.optional() }).strict() },
};
