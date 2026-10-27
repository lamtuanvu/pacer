# Plugin UI contributions: `contributes.ui`

Date: 2026-10-28. Status: proposed, awaiting the maintainer's approval. Applies to: `src/plugins/**`, `src/api/ops.ts`, `src/core/plugins.ts`, `packages/plugin-sdk/**`, `crates/plugin-sdk/**`, `conformance/**`, `scripts/plugin-protocol-doc.ts`, `docs/plugin-protocol.md`, `docs/plugin-protocol.schema.json`, `docs/protocol.md`, `app/**`, `src/view-model/**`.
Decision record: [ADR 0010](../decisions/0010-plugin-ui-contributions.md).
Builds on:
- [plugin system](2026-10-19-plugin-system-design.md), [plugin host core](2026-10-19-plugin-host-core-design.md) and [ADR plugin-host-and-rust-strangler](../decisions/2026-10-19-plugin-host-and-rust-strangler.md)
- [app redesign](2026-10-27-app-redesign-design.md), slice 9
- [design system](2026-10-19-design-system-beautiful-ui-design.md) and [ADR shared-ui-foundations](../decisions/2026-10-19-shared-ui-foundations.md)

## Problem

The redesign leaves room in the app for plugins: a plugin section in the activity bar, plugin tabs in the right panel, plugin pages under Settings › Extend, and items in the status bar. The plugin protocol has no way to fill them. Its manifest's `contributes` covers only `diagnostic`, `agentSession`, `observation` and `decision`.

Letting plugins ship their own HTML, CSS or JavaScript into the app would break several agreements:
- the app's CSP and its single-origin trust boundary (SEC-4, SEC-8);
- the design system's ownership of controls and tokens (UI-19, UI-21);
- the one status vocabulary (UI-10) and the accessibility rules (UI-2);
- P1, under which clients talk only to the service, never to a plugin.

## Goals

1. Plugins can add four kinds of surface: an **activity-bar item** with its view, a **right-panel tab**, a **settings page**, and a **status-bar item**.
2. All plugin content is data. The host validates it against a schema, and the app renders it with design-system components. A plugin ships no CSS, JavaScript, HTML, fonts, images or URLs that the app loads.
3. The user sees, before granting, which surfaces a plugin adds and what it may access, and can hide any single surface.
4. The change is additive under P4 and P14, documented by generation (P11), and covered by the conformance suite.
5. The CLI stays complete (ARCH-8): plugin settings can be read and written without the app.

Non-goals:
- Arbitrary layouts, charts or custom widgets. Anything beyond the node set below needs a protocol change.
- A plugin marketplace or "Browse" tab. The canvas shows one; it is a separate decision.
- Plugin access to client protocol writes. A plugin acts only through its own capabilities.

## Model

Three layers, each owning one thing:

| Layer | Owns |
|---|---|
| Plugin | Declares its surfaces in the manifest; returns view documents and handles actions when the host asks |
| Host (`pacer serve`) | Validates manifests and every document, enforces grants and limits, brokers calls, stores plugin settings and surface visibility, publishes events |
| App | Lists surfaces and renders documents with `app/src/ds/`; sends actions through the host. Never talks to a plugin, and never evaluates plugin content as code or markup |

## Manifest: `contributes.ui`

`ui` becomes an extension point in `EXTENSION_POINTS`. Unlike the others, its value has a fixed schema instead of free JSON:

```jsonc
"contributes": {
  "ui": {
    "activity":  [{ "id": "checklist", "title": "Release checklist", "icon": "check-square", "view": "checklist" }],
    "panelTabs": [{ "id": "checklist-tab", "title": "Checklist", "icon": "check-square", "view": "task-checklist", "context": "task" }],
    "settings":  [{ "id": "settings", "title": "Release checklist", "schema": { /* settings schema, below */ } }],
    "status":    [{ "id": "open-items", "title": "Open checklist items", "view": "status" }]
  }
}
```

| Field | Rules |
|---|---|
| `id` | `^[a-z0-9][a-z0-9-]{0,31}$`, unique within the plugin |
| `title` | Plain text, 1–40 characters. Shown as the label, tooltip and accessible name |
| `icon` | A name from the design system's icon set, as listed in the generated protocol doc. Unknown names render a generic plugin icon |
| `view` | A name the plugin passes back to itself in `ui.render`; 1–64 characters |
| `context` | For `panelTabs`: `global` (default) or `task`. A `task` tab appears only when a task is selected, and receives its id |

Limits per plugin: 2 activity items, 3 panel tabs, 1 settings page and 1 status item. The canvas shows a plugin page with one schema, and a single page keeps Settings › Extend readable. Whether to raise the limits is an open decision.

A manifest with `contributes.ui` sets `host` to a range starting at the pacer release that adds it. An older host rejects the unknown extension point at parse time and marks the plugin `refused` with the manifest error, which is the existing behavior for an unknown key.

## Host methods (plugin protocol)

New host → plugin methods, served by plugins that contribute `ui`:

| Method | Params | Result | Deadline |
|---|---|---|---|
| `ui.render` | `{ surface: "activity" \| "panelTab" \| "status", id, view, context: { route, taskId?, theme: "light" \| "dark" } }` | `{ document: ViewDocument, ttlS?: number }` | 2 s |
| `ui.action` | `{ surface, id, action, context, requestId, values?: Record<string, Json> }` | `{ result: "done" \| "refresh", message?: string }` or a `CoreError` | 10 s |
| `ui.settings.validate` | `{ id, values }` | `{ ok: true } \| { ok: false, errors: { path, message }[] }` | 2 s |

New plugin → host notification, needing no capability: `ui.invalidate { id? }`. It asks the host to re-render one surface or all of them. The host coalesces it to at most one `plugin` event per plugin per second, and drops it for hidden surfaces.

`context` never carries more than a route name, the selected task's id and the theme. To read the task itself, a plugin needs the `tasks.read` capability, exactly as today. Settings are not passed to `ui.render`; the plugin reads them with `config.get`.

## View documents

A `ViewDocument` is a tree of typed nodes. The host validates it with zod before any client sees it. Anything invalid replaces the whole surface with a host-drawn error state ("This plugin's view couldn't be shown"), and the details go to the plugin's log.

| Node | Fields | Rendered by |
|---|---|---|
| `section` | `title?`, `children` | `Section` |
| `stack` | `gap: "related" \| "content"`, `children` | `Stack` (UI-27 spacing) |
| `heading` | `text`, `level: 2 \| 3` | DS heading styles |
| `text` | `text`, `tone?: "muted"` | Body text |
| `keyValue` | `items: { label, value }[]` (≤ 50) | Settings/metadata row grammar |
| `list` | `items: ListItem[]` (≤ 200), `empty` text | `ListRow` |
| `status` | `label`, `tone: "neutral" \| "info" \| "good" \| "warn" \| "bad"` | `StatusPill`, with the label always shown (UI-2) |
| `meter` | `label`, `usedPct`, `pacePct?` | `UsageMeter` |
| `code` | `text` (≤ 16 KiB) | Monospace block, no highlighting |
| `link` | `label`, `to: { route, taskId? }` | Internal navigation only |
| `button` | `label`, `action`, `variant: "secondary" \| "quiet" \| "danger"`, `confirm?: { title, body }` | `Button`. Never the primary variant: the host owns each region's one primary action (UI-14) |
| `checkbox` | `label`, `name`, `checked`, `action` | DS checkbox; toggling sends `ui.action` with `values` |
| `empty` | `title`, `body?` | DS empty state |

A status item's document has one node: `status` or `text`, at most 24 characters, optionally wrapped in a `button` whose action opens the plugin's activity view.

Rules for every node:
- **Text is text.** Every string renders as a text node. Nothing is parsed as HTML, Markdown or a URL. Control characters are stripped and bidirectional overrides removed, and strings longer than their limit are rejected.
- **No external content.** There are no image nodes, no external links, no `href`, no style or class fields, and no colour values. Tone comes only from the status vocabulary.
- **No free text input in views.** A view can't draw a text field, so a plugin can't ask the user for a password or key inside pacer's chrome. Text input exists only on settings pages, from the declared schema.
- **Bounded.** At most 64 KiB serialized, 500 nodes and a depth of 8.
- **Labelled controls.** A `button` or `checkbox` without a label fails validation (UI-2).

## Settings pages

A settings page is drawn from a schema in the manifest, not from a view document, so its shape is known before the plugin runs, and the grant prompt can describe it.

The schema is a closed subset of JSON Schema:

| Field type | Control | Constraints |
|---|---|---|
| `boolean` | Switch | — |
| `string` with `enum` | Dropdown or segmented control | ≤ 20 options |
| `string` | Text field | `maxLength` ≤ 2000, optional `pattern` |
| `integer` | Number field | `minimum`, `maximum` required |
| `array` of `string` | Ordered list with add, remove and reorder (`SortableList`) | `maxItems` ≤ 100 |
| `repos` | Repository picker over repositories pacer knows | — |

Each field has `title` and `description` (plain text), which become the `SettingRow` label and help. There is **no secret field type**. A plugin that needs a key uses `secrets.resolve` with a reference the user configures through pacer's existing secret storage (P5, SEC-2), and the settings page can only show whether that reference resolves.

Saving goes through a `SaveBar`: nothing saves silently. The host validates the values against the schema, then calls `ui.settings.validate` when the plugin is running. It writes them to `plugins.config.<id>`, the store `config.get` already reads, through the config mutation path. The write bumps a per-plugin settings revision, which is new and stored beside the values, and publishes `config` with area `plugins`, as `plugin.enable` already does. (The protocol doc's list of config areas omits `plugins` today; the regenerated doc adds it.) The plugin receives the new values on its next `config.get`. A running plugin also gets a `ui.invalidate`-style refresh of its surfaces.

The page header is drawn by the host, not the plugin: the plugin's name, version and publisher, what it may access, "Manage plugin" and "Turn off". The footnote says the page is drawn by pacer from the plugin's settings schema.

## Client protocol (v3, additive)

| Op | Params | Result |
|---|---|---|
| `plugin.ui.list` | `{}` | Every surface of every enabled, granted plugin: `{ plugin, surface, id, title, icon, context, visible, state }`. Starts nothing |
| `plugin.ui.render` | `{ plugin, surface, id, context }` | `{ document, renderedAt, ttlS }`. Starts the plugin if it is idle |
| `plugin.ui.action` | `{ plugin, surface, id, action, context, requestId, values? }` | `{ result, message? }` |
| `plugin.ui.visibility` | `{ plugin, surface, id, visible, expect_rev }` | The updated surface. Conflicts return `conflict` (P2) |
| `plugin.settings.get` | `{ plugin }` | `{ schema, values, rev }` |
| `plugin.settings.set` | `{ plugin, values, expect_rev }` | `{ values, rev }`, or `invalid_input` with field errors in `data` |

- `plugin.list` gains an additive `ui` field per plugin, with the counts of each surface type.
- The existing `plugin` event gains an additive `{ id, ui: { surface?, id? } }` form when a surface should be re-rendered.
- Visibility is service state, not client state (ARCH-1), so every app window and the tray agree. It is stored in the plugins config.
- Every write op requires the app's normal write checks (P6, SEC-4).

Errors use existing codes (API-4): `unknown_plugin`; `not_found` for an unknown surface or action; `plugin_unavailable` when the plugin is disabled, `needs_grant` or failing; `plugin_timeout`; `capability_denied` when the plugin's grant doesn't cover a capability it needs; `invalid_input` for an invalid document (from the plugin) or invalid settings (from the user); and `conflict`. The app maps each one to a host-drawn state in the surface, never to the plugin's own text.

## Permissions shown to the user

The grant flow (`plugin.enable` returning `needs_grant`) shows two lists in plain words, the canvas's "Adds" and "May" rows:

- **Adds:** each declared surface, for example "Settings page", "Activity view", "Right-panel tab: Checklist", "Status bar item".
- **May:** each capability, with its scopes: "Read tasks", "Run programs: `gh`", "Reach the network: api.example.com", "Use the secret reference `acme-token`".

Two changes to the grant model:
- **UI surfaces are part of the grant.** A recorded grant today covers capability names only. It gains the set of surface kinds. A new version that adds a surface kind drops back to `needs_grant`, as one that adds a capability does now. A new surface of an existing kind, or a changed title, does not.
- **Scopes are shown.** The prompt lists scopes, which the grant check currently ignores. Whether the grant should also record and compare scopes is an open decision, because it changes existing behavior for installed plugins.

Bundled plugins are trusted by being bundled, as today, and their surfaces are listed in the same way.

Wherever a plugin surface appears, the host marks its origin: plugin tabs and activity items carry a "plugin" badge in their tooltip and accessible name, plugin settings pages are listed under Extend with "plugin" beside them, and every confirmation dialog a plugin action opens names the plugin.

## Behavior and limits

- **Lazy start.** Listing surfaces starts nothing. Rendering a visible surface starts the plugin, which is the existing lazy start. A status item is rendered once when the app loads, and again only on `ui.invalidate`, its `ttlS` (at least 30 s) or a `plugin` event. There is no polling faster than that.
- **Cache.** The host keeps the last valid document per surface and context in memory for its `ttlS` (default 60 s, at most 1 hour). A crashed or slow plugin shows its last document, marked out of date, and then an error state.
- **Actions.** Calls to one plugin run one at a time unless it is `reentrant`, as now. `requestId` makes a repeated action safe. A `confirm` dialog is drawn by the host before the call is sent. The app limits each surface to one action in flight.
- **Accessibility and theme.** The host renders, so UI-2, UI-10, UI-21, UI-26 and UI-27 hold by construction. `theme` lets a plugin choose wording ("dark mode"), not colours.
- **Narrow screens.** Activity items move to the plugin section of the navigation sheet. Panel tabs move with the right panel into its sheet. Status items are hidden with the status bar, as the redesign already specifies.
- **TUI and CLI (ARCH-8).** `pacer plugin settings get|set <id>` reads and writes settings as JSON, validated by the same schema. `pacer plugin ui list` lists surfaces. Whether the TUI renders view documents is an open decision; the node set is chosen so that a text rendering is possible.

## Versioning and generation

- **Plugin protocol 1.1.0 → 1.2.0.** A new extension point, three methods and one notification, all additive (P14, ARCH-14). A plugin built for 1.1 is unaffected, and the protocol major stays 1. The host keeps refusing a different major.
- **View document schema.** It is part of the plugin protocol version. A new node type is additive. A plugin that sends a node type the host doesn't know fails validation, so plugins check `plugin.hello`'s `pacer` version before using newer nodes. Whether the host should instead drop unknown nodes is an open decision. Dropping would hide content silently, which UI-6 discourages.
- **Client protocol v3.** New ops and additive fields only (P4, API-1). The protocol version stays 3.0.0.
- **Generation (P11).** The `ui` manifest schema, the methods and the view-document schema are zod schemas in `src/plugins/protocol.ts`. `bun run plugin:protocol` renders them into `docs/plugin-protocol.md` and `docs/plugin-protocol.schema.json`, including the icon names and the node table. `bun run protocol:doc` renders the new client ops. Both freshness tests cover them.
- **SDKs.** `@pacer/plugin` gains typed builders for documents and settings schemas. `pacer-plugin` (Rust) gains the generated types through `cargo xtask gen` (CRATE rules). Neither adds a runtime dependency.
- **Conformance.** A fixture plugin under `conformance/` contributes one surface of each kind. Tests cover a valid document, each validation failure (size, depth, unknown node, missing label, control characters), a timeout, a crash, invalidation coalescing, a settings round trip with a conflicting revision, and the grant re-prompt when a new version adds a surface kind.

P13 and P15 are unchanged. UI surfaces are a capability that plugins provide, and the host provides only the rendering. A commercial plugin may show its licence state in its own views, while the host still checks no entitlement.

## Security notes

- **No plugin code in the app.** The app's CSP is unchanged, and no plugin-provided string reaches `innerHTML`, a URL, a style or an event-handler attribute. The source checks gain a rule that `app/src/plugins/**` renders only through DS components.
- **Untrusted text.** Plugin text may imitate pacer's own UI. The provenance markings, the host-drawn headers and confirmation dialogs, the missing text input in views and the missing primary buttons limit what it can imitate. They don't remove the risk, which is why surfaces are part of the grant.
- **Resource limits.** Document size, node count, deadlines, render caching and event coalescing bound what one plugin can cost the service and the app.
- **Settings integrity.** Settings writes are user actions through the app's authenticated write path, validated by the host before the plugin sees them. A plugin cannot write its own settings through the UI ops.
- **Logs.** Validation failures log the plugin id, surface and error path, never document content, since it may contain task data.

## Delivery

Slice 9 of the redesign, in three PRs:

1. The protocol: manifest schema, host methods, validation, settings storage and ops, grant change, generated docs, SDK builders and conformance. No app change.
2. The app: activity items, panel tabs, status items and settings pages rendered from documents and schemas, with provenance markings, error and out-of-date states, and visibility toggles. UI evidence per UI-24.
3. A bundled reference plugin, or a conformance fixture promoted to an example, that exercises all four surfaces. CT-11 live validation installs it into a sandbox `PACER_HOME`, grants it, renders every surface, saves settings, runs an action with a confirmation, upgrades it to a version with a new surface kind (re-prompt), and disables it. Surfaces not exercised live are reported as UNVERIFIED.

Each PR updates `docs/plugin-protocol.md` (generated) and the plugin docs pages, and adds a CHANGELOG Unreleased entry (REPO-7).

## Governance

Constitution 0.15.0. Applicable: P1, P2, P4–P6, P11, P13–P15; ARCH-1–3, ARCH-8, ARCH-9, ARCH-12–14; API-1–4; SEC-2, SEC-4, SEC-5, SEC-7, SEC-8; UI-2, UI-6, UI-10, UI-12–14, UI-19, UI-21, UI-26, UI-27; CT-11; REPO-2, REPO-3, REPO-7. No rule changes are needed, so there is no amendment. The durable decision, plugin UI as host-rendered data only, is recorded in ADR 0010 (ARCH-9, P12).

## Open decisions

For the maintainer. Each has a proposal, but none is assumed.

1. **Surface limits.** 2 activity items, 3 panel tabs, 1 settings page and 1 status item per plugin, or other numbers?
2. **Scopes in grants.** Should a recorded grant store capability scopes and re-prompt when they widen? That would change the grant check for plugins already installed.
3. **Unknown nodes.** Reject the whole document (proposed), or drop unknown nodes and show the rest?
4. **TUI rendering.** Render view documents as text in the TUI, or show only a pointer to the app and the CLI settings commands?
5. **Actions without confirmation.** Should every plugin action need a host confirmation dialog, or only those the plugin marks `confirm`, plus every `danger` button (proposed)?
6. **External links.** The proposal allows none. Should plugins be able to offer an `https` link that opens in the system browser after a host confirmation showing the full URL?
7. **Browse and Updates tabs.** The canvas shows plugin discovery and updates. They need a source of plugins and an update trust model, which belong in a separate spec.
