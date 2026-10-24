# App spacing ownership

The maintainer requested an app-wide spacing audit, fixes and rules preventing recurrence, following a task-result screenshot with oversized, inconsistent gaps. The cleanup preserves the existing design, controls and information hierarchy.

Approaches considered: changing token values alone leaves compounded margins and incorrect grouping; screen-by-screen overrides multiply inconsistency; shared layout ownership fixes those causes centrally. The maintainer authorized proceeding with the shared cleanup without further design review.

DS gaps own child separation: 8px for related elements, 12px for content, 24px between regions. Direct children of shared layouts have zero block margins. Headers retain a standalone margin only outside a gap-owning parent. Task disclosures share one compact stack; summaries retain 36px desktop and 48px touch minima. Settings remove paragraph/heading margins that compound layout gaps. Session lists use the same region/content rhythm, and reports do not add an extra outer margin.

Prose, nested list indentation, data tables, terminal geometry, setup choices and multiline composer fields retain intentional spacing. No API, state, behavior of actions or dependency changes are needed. New spacing ownership rule UI-27 follows the constitution's amendment process and remains proposed until maintainer merge.

Validation uses failing-then-passing browser geometry regressions, checker negative cases, full checks, light/dark desktop/phone before/after screenshots and CT-11 live evidence. Independent UI/accessibility and QA reviews remain required. VoiceOver is WAIVED under VO-TEMP-2026-10; inaccessible surfaces are UNVERIFIED.
