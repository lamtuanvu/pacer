/** Typed builders for `ui.render` documents and `contributes.ui`. The host validates everything; these only help you write it. */
export type Tone = "neutral" | "info" | "good" | "warn" | "bad";
export type ViewNode =
  | { type: "section"; title?: string; children: ViewNode[] }
  | { type: "stack"; gap: "related" | "content"; children: ViewNode[] }
  | { type: "heading"; text: string; level: 2 | 3 }
  | { type: "text"; text: string; tone?: "muted" }
  | { type: "keyValue"; items: { label: string; value: string }[] }
  | { type: "list"; items: { title: string; subtitle?: string; status?: { label: string; tone: Tone }; action?: string }[]; empty: string }
  | { type: "status"; label: string; tone: Tone }
  | { type: "meter"; label: string; usedPct: number; pacePct?: number }
  | { type: "code"; text: string }
  | { type: "link"; label: string; to: { route: string; taskId?: string } }
  | { type: "button"; label: string; action: string; variant: "secondary" | "quiet" | "danger"; confirm?: { title: string; body: string } }
  | { type: "checkbox"; label: string; name: string; checked: boolean; action: string }
  | { type: "empty"; title: string; body?: string };

export const ui = {
  section: (children: ViewNode[], title?: string): ViewNode => ({ type: "section", ...(title ? { title } : {}), children }),
  stack: (children: ViewNode[], gap: "related" | "content" = "content"): ViewNode => ({ type: "stack", gap, children }),
  heading: (text: string, level: 2 | 3 = 2): ViewNode => ({ type: "heading", text, level }),
  text: (text: string, tone?: "muted"): ViewNode => ({ type: "text", text, ...(tone ? { tone } : {}) }),
  status: (label: string, tone: Tone = "neutral"): ViewNode => ({ type: "status", label, tone }),
  button: (label: string, action: string, variant: "secondary" | "quiet" | "danger" = "secondary", confirm?: { title: string; body: string }): ViewNode => ({ type: "button", label, action, variant, ...(confirm ? { confirm } : {}) }),
  checkbox: (label: string, name: string, checked: boolean, action: string): ViewNode => ({ type: "checkbox", label, name, checked, action }),
  empty: (title: string, body?: string): ViewNode => ({ type: "empty", title, ...(body ? { body } : {}) }),
};

export type SettingsField =
  | { type: "boolean"; title: string; description?: string; default?: boolean }
  | { type: "string"; title: string; description?: string; enum?: string[]; maxLength?: number; default?: string }
  | { type: "secretRef"; title: string; description?: string }
  | { type: "integer"; title: string; description?: string; minimum: number; maximum: number; default?: number }
  | { type: "array"; items: { type: "string" }; title: string; description?: string; maxItems: number }
  | { type: "repos"; title: string; description?: string; maxItems?: number };
export interface UiContribution {
  activity?: { id: string; title: string; icon: string; view: string }[];
  panelTabs?: { id: string; title: string; icon: string; view: string; context?: "global" | "task" }[];
  settings?: { id: string; title: string; schema: { fields: Record<string, SettingsField> } }[];
  status?: { id: string; title: string; view: string }[];
}
