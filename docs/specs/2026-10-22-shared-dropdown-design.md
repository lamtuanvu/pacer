# Shared dropdowns and aligned work-entry forms

Date: 2026-10-22
Status: Proposed for maintainer review
Scope: Pacer web app and the same app hosted by the Tauri desktop shell

## Intent and success

Dropdowns throughout Pacer should look and behave like one product, rather than opening OS-native menus with varying appearance. Start work should have aligned form rows. The requester approved a product-wide scope after identifying native dropdowns and uneven fields in Start work. The existing design-system density, color, typography and accessibility rules remain in force; this is not a redesign of unrelated buttons, text fields or the agent terminal.

Success is one shared visual and interaction contract for all current single-choice app dropdowns, with reliable selection, forms, keyboard, pointer and screen-reader behavior at desktop and narrow widths. The textarea remains multiline and the native file picker remains the underlying file input, but its visible trigger uses the shared button appearance.

## Current state and alternatives

`app/src/ds/Controls.tsx` owns `Select`, which renders a native `<select>`. The app has 23 uses across nine screen files: Start work, Delegate, Quick Delegate, Session retry, Review verdict, and four Settings areas. `Field` discovers `Select` and connects its label/help/error. `RepoFilter` already uses a separate custom `SearchPicker`. The closed select is token-styled, but its opened choices belong to the browser/OS. Start work additionally uses a generic `.form-row` with `align-items:flex-end`; the Base branch help line changes the height of one field and vertically displaces Workspace.

1. **CSS-only refresh:** keep `<select>` and improve the closed box and grid. Smallest change, but the opened menu stays native and does not meet the requested cross-screen consistency.
2. **New shared custom picker (selected):** add a Pacer-owned single-choice picker to `ds/`, reuse tokens and the existing repo-finder visual grammar, and migrate the 23 callers. This makes the open menu consistent and handles long lists, disabled reasons and touch/keyboard access, at the cost of explicit form and accessibility work.
3. **Install a third-party headless select:** supplies some keyboard behavior but adds a runtime dependency, adaptation risk with Preact and bundle-budget pressure. It does not solve Pacer's field/layout integration automatically.

## Component contract

Add a `ChoicePicker` design-system component with a controlled `value`, an array of `{ value, label, disabled?, reason?, description? }` options, and `onValueChange(value)`. It accepts `id`, `name`, `required`, `disabled`, `aria-label`, `aria-describedby`, `aria-invalid`, `className` and an optional searchable mode. It never imports screen or service state. Screens keep their current domain decisions and supply plain labels, availability and reasons. There is no synthetic `HTMLSelectElement` change event.

The trigger is a shared-density button-like control with selected label or placeholder, chevron, and open/closed state. It follows the same compact desktop and 48px narrow/touch sizing as other controls. The popup is constrained to the viewport, scrolls internally, and uses design tokens for surface, border, shadow, type, option focus/selection and disabled states. Long repository, executor, branch and model lists can search; short enums open directly. `SearchPicker` keeps its existing repository-filter semantics but shares popup/row styling where practical so it does not become a second visual language. No Pacer-authored control becomes an unstyled raw input/select.

The picker uses a single-choice listbox pattern: the trigger has an accessible name, `aria-haspopup="listbox"`, expanded state and controls relationship; the popup announces selection and disabled options. Enter/Space opens and chooses, arrows/Home/End navigate available options, typing searches or performs typeahead, Escape closes and restores focus, and Tab exits without trapping focus. Pointer selection, outside click, scrolling, narrow placement, focus-visible and reduced motion are included. Popups opened inside a modal stay inside that modal's focus/top-layer boundary. Disabled options show a reason but cannot be committed. A changing option set retains a valid selection or visibly returns to an unselected/required state; it never silently chooses a different executor.

Native form semantics must remain intentional. The component emits the selected value through a hidden named value only when a form needs serialization; required picks are validated at the owning form boundary with visible `Field` feedback and focus returned to the picker trigger. The Start work and Delegate submit paths must explicitly reject missing required picks rather than rely on an invisible native select. Existing controlled callers continue to own state. `Field` must recognize the new component, attach label/help/error IDs to its trigger and preserve explicit IDs and refs used by retry focus handling. The old `Select` can remain internally only for a documented compatibility case; the migration is complete when no app screen renders a native select popup.

## Screen layout

Start work uses a scoped two-column grid: Repository beside Agent and account; Workspace beside Base branch or Existing checkout. Each field's label and trigger align at the top of its row. Help/error text stays beneath its own trigger and does not move the neighboring field. At the narrow breakpoint, the grid becomes one column with full-width touch targets. The textarea keeps its useful height. Attach files shows a canonical secondary button and selected-file feedback while preserving the native file input for file selection, paste and drop.

Other screens retain their domain layouts; the picker receives size and appearance only from the shared design system. Where a current layout depends on native select dimensions, adjust that layout locally without overriding picker typography, radius or control height.

## Validation and rollout

Tests precede implementation changes. Component tests cover controlled updates, empty/required/disabled options, option-list refresh, keyboard navigation, focus return, typeahead/search, pointer/outside close, label/help/error wiring, and form submission. Screen regressions cover Start work, Delegate, Quick Delegate, retry, review and Settings value changes, especially disabled executor reasons and existing refs. The generated app bundle stays under UI-3 budgets; `bun run typecheck`, `bun run ui:check`, `bun run app:build`, and `bun run test` pass.

Browser visual/interaction evidence covers Start work, Delegate, retry/review and representative Settings at 1440px light/dark and 375px, including open popups, keyboard/focus, contrast, long labels and viewport containment. Live harness validation exercises the changed app through the sandbox public proxy and the same UI in the isolated desktop shell; unchanged TUI/CLI and tray surfaces are reported as not affected rather than invented as passing. Reports retain exact source provenance, before/after captures and any honestly unexercised surface. Manual spoken VoiceOver is WAIVED only under VO-TEMP-2026-10. The PR evidence manifest and independent UI/QA reviews update to the final base/head before the ready PR is considered complete.

## Constraints and rule mapping

No API or service operation changes are needed. ARCH-1 and UI-20 keep presentation separate from state. UI-1/8/9/16/19/21/22/25 require canonical token-driven controls and catalog updates; UI-2 requires names, focus, contrast and keyboard access; UI-3 preserves bundle budgets; UI-18/24 require actual visual and independent review evidence; UI-26 governs density and touch targets. CT-1/3/4/5/11 require strict types, tests, fresh embedded assets and live validation. REPO-1/2/3/4/6/7 keep working evidence untracked, this design tracked, commits signed off and user-facing docs current. No rule amendment or new ADR is proposed because this extends the established shared design system without changing client/service boundaries.
