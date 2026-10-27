# ADR 0010: Plugin UI is host-rendered data

Status: Proposed, 2026-10-28

## Context

The redesigned app has places for plugins: activity-bar items, right-panel tabs, settings pages under Settings › Extend, and status-bar items. The plugin protocol (1.1.0) has no UI extension point. The usual ways other tools let extensions add UI are to load extension HTML and JavaScript into a web view or iframe, or to give extensions a component API inside the app's own bundle. Either way pacer would run plugin code in the app's origin or beside it. That conflicts with the app's CSP and single trust boundary (P6, SEC-4, SEC-8), the design system's ownership of controls and tokens (UI-19, UI-21), and P1, under which clients talk only to the service.

## Decision

Plugins contribute UI as data only.

- A new extension point, `contributes.ui`, declares four kinds of surface: `activity`, `panelTabs`, `settings` and `status`. Each has an id, a plain-text title and a design-system icon name.
- Settings pages are drawn from a closed JSON Schema subset declared in the manifest. Values are validated by the host and stored in the existing plugin config. There is no secret field type: secrets stay references (P5).
- Other surfaces are drawn from **view documents**: bounded trees of typed nodes that the plugin returns from `ui.render`. The host validates every document against a zod schema and passes only valid documents to clients. The app renders them with `app/src/ds/` components.
- Plugins ship no CSS, JavaScript, HTML, images or URLs that the app loads. Strings are always rendered as text. Views have no text input and no primary buttons. Every plugin surface, header and confirmation dialog is marked with its plugin by the host.
- User actions go from the app through new client ops to the host, which calls `ui.action` on the plugin. Plugins never call client ops.
- UI surface kinds become part of a plugin's grant, so a version that adds a kind of surface asks the user again.
- The change is additive: plugin protocol 1.2.0 and new client v3 ops, with generated docs and conformance tests (P4, P11, P14).

## Consequences

- Plugin UI looks and behaves like the rest of pacer, and inherits accessibility, theming, density and the status vocabulary without review of each plugin.
- What plugins can show is limited to the node set. Richer views, such as charts or editors, each need a protocol addition. That is deliberate.
- Plugin text can still imitate pacer's wording. Host-drawn provenance and confirmations, and including surfaces in the grant, reduce that risk but don't remove it.
- The host validates and caches documents, which adds per-render cost to the service. Size limits, deadlines and coalesced invalidation bound that cost.
- The CLI gains plugin settings commands, so plugin configuration doesn't depend on the app (ARCH-8).

Spec: [plugin UI contributions](../specs/2026-10-28-plugin-ui-contributions-design.md).
