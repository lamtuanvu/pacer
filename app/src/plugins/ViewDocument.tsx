import type { ViewNode } from "../../../src/plugins/ui-schema";
import { Button } from "../ds/Button";
import { Checkbox } from "../ds/Controls";
import { Stack, Section, TextRow, ListRow, EmptyState } from "../ds/Patterns";
import { SectionHeading } from "../ds/SectionHeading";
import { StatusPill } from "../ds/StatusPill";
import { UsageMeter } from "../ds/UsageMeter";
import { AppLink } from "../navigation";
import { routes, type RouteTarget } from "../router";

export interface ViewAction { action: string; label: string; variant?: "secondary" | "quiet" | "danger"; confirm?: { title: string; body: string }; values?: Record<string, boolean> }
export function pluginLink(to: Extract<ViewNode, { type: "link" }>["to"]): RouteTarget {
  switch (to.route) {
    case "start": return routes.start();
    case "overview": return routes.overview();
    case "review": return routes.needsYou();
    case "sessions": return to.taskId ? routes.task(to.taskId) : routes.tasks();
    case "terminal": return routes.terminal();
    case "settings": return routes.settings();
    case "hosts": return routes.hosts();
    case "add-executor": return routes.addExecutor();
    case "setup": return routes.setup();
  }
}
/** The schema's text is only ever a child; destinations, classes and appearance are host owned. */
export function ViewDocument({ document: node, onAction, busy = false }: { document: ViewNode; onAction: (action: ViewAction) => void; busy?: boolean }) {
  const children = (nodes: ViewNode[]) => nodes.map((document, key) => <ViewDocument key={key} document={document} onAction={onAction} busy={busy} />);
  const status = (value: { label: string; tone: "neutral" | "info" | "good" | "warn" | "bad" }) => <StatusPill status={{ ...value, glyph: "" }} />;
  switch (node.type) {
    case "section": return node.title ? <Section title={node.title}>{children(node.children)}</Section> : <Stack>{children(node.children)}</Stack>;
    case "stack": return <Stack space={node.gap === "related" ? "compact" : "normal"}>{children(node.children)}</Stack>;
    case "heading": return <SectionHeading as={node.level === 2 ? "h2" : "h3"}>{node.text}</SectionHeading>;
    case "text": return <p className={node.tone === "muted" ? "pc-plugin-muted" : undefined}>{node.text}</p>;
    case "keyValue": return <Stack space="compact">{node.items.map((item, key) => <TextRow key={key} label={item.label} value={item.value} />)}</Stack>;
    case "list": return node.items.length ? <Stack space="compact">{node.items.map((item, key) => <ListRow key={key} content={<><span>{item.title}</span>{item.subtitle && <p>{item.subtitle}</p>}</>} meta={item.status && status(item.status)} actions={item.action && <Button aria-disabled={busy} disabled={busy} onClick={() => onAction({ action: item.action!, label: "Open" })}>{busy ? "Working…" : "Open"}</Button>} />)}</Stack> : <EmptyState title={node.empty} />;
    case "status": return status(node);
    case "meter": return <UsageMeter label={node.label} used={node.usedPct} pace={node.pacePct ?? null} tone="neutral" size="bar" />;
    case "code": return <pre className="pc-plugin-code" tabIndex={0}><code>{node.text}</code></pre>;
    case "link": return <AppLink to={pluginLink(node.to)}>{node.label}</AppLink>;
    case "button": return <Button variant={node.variant} aria-disabled={busy} disabled={busy} onClick={() => onAction(node)}>{busy ? "Working…" : node.label}</Button>;
    case "checkbox": return <Checkbox label={busy ? <>{node.label} · Working…</> : node.label} checked={node.checked} aria-disabled={busy} disabled={busy} onChange={event => onAction({ action: node.action, label: node.label, values: { [node.name]: event.currentTarget.checked } })} />;
    case "empty": return <EmptyState title={node.title} description={node.body} />;
  }
}
