# pacer design system

Source: [pacer redesign](https://claude.ai/artifact/8yQnnd5BtUdRncrBVogp3r), first drawn for the retired Orca plugin panel. These standalone boards preserve the exported markup and inline styles, with neutral sample projects and tasks: [Brand](boards/brand.html), [Overview](boards/overview.html), [Setup](boards/setup.html), [Delegate](boards/delegate.html), [Strategy](boards/strategy.html). Open the HTML files directly in a browser; vendor marks remain as supplied. They are reference boards, not functioning screens.

## Principles and mark

One mark, drawn from what pacer does: keep a quota on pace. A quiet lane, a used bar, and a pace tick communicate the product without a separate mascot. Keep status separate from identity.

**A · Pace marker** is chosen and ships in [`assets/pacer-mark.svg`](assets/pacer-mark.svg): “The usage bar with the pace tick ahead of it: the exact element the panel shows. Reads at 16 px.” Keep its 48×48 geometry: lane at (4,20), 40×8; used bar 22×8; tick at (29,12), 4×24. Use at 16, 24 and 32 px; the app icon places the dark mark on an Ink rounded square.

Rejected directions, as described on the brand board:

- **B · Lap:** “A week as a lap of a track, the runner partway round. Friendlier, closer to a stopwatch.” It moves the metaphor toward timing rather than the usage bar.
- **C · Handoff:** “Planner passes work to an executor. Says delegation, not pacing; easy to confuse with a fast-forward icon.”

[Canonical mark](assets/pacer-mark.svg), [dark mark](assets/pacer-mark-dark.svg), [app icon](assets/pacer-app-icon.svg).

## Colour tokens and implementation map

The accent is used **only in the mark and the pace tick, never for status**. Status has its own green, amber, red and blue.

| Token | Reference values | Where it lives today |
| --- | --- | --- |
| Ink | #18181B | `pacer-mark.svg` used bar |
| Track | #65A30D light / #A3E635 dark | `pacer-mark.svg` tick |
| Lane, brand page | #F4F4F5 | Brand board |
| Lane, shipped mark | #E4E4E7 light / #52525B dark | `pacer-mark.svg` lane; **the shipped SVG is canonical**, despite the brand-page swatch difference |
| Good | #15803D / #16A34A; pill #DCFCE7 / #166534 | Boards |
| Ahead / warning | #D97706; pill #FEF3C7 / #92400E | Boards |
| Bad | #DC2626 / #B91C1C; pill #FEE2E2 / #991B1B; card border #FECACA, surface #FFFBFB | Boards |
| Info | surface #EFF6FF / text #1E3A8A | Setup board; `.note.info` in `style.ts` uses a dodgerblue mix |
| Link | #1D4ED8 (hover #1E3A8A) | Board head styles; panel inherits host/link styling |
| Zinc 50 / 100 | #FAFAFA / #F4F4F5 | Board backgrounds and muted surfaces; panel `--background`, `--card`, `--muted` supplied by Orca |
| Zinc 200 / 300 | #E4E4E7 / #D4D4D8 | Board borders, lanes and inputs; panel `--border` supplied by Orca |
| Zinc 400 / 500 | #A1A1AA / #71717A | Board disabled and secondary text; panel `--muted-foreground` supplied by Orca |
| Zinc 600 / 700 / 900 | #52525B / #3F3F46 / #18181B | Board body text, neutral pills and Ink; panel `--foreground`, `--primary` supplied by Orca |
| White | #FFFFFF | Board surfaces and inverse text; mark's dark used bar |
| Saved strategy | border #BBF7D0 / surface #F7FEF9 | Strategy board; `.strategy-saved` in `style.ts` uses green mixes |

Slash-separated status values above describe board foregrounds or surface/text pairs, not a complete light/dark theme. The boards are light references; the mark explicitly defines light and dark variants.

## Typography and geometry

The wordmark is lowercase **pacer**, using `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`, weight 650, letter-spacing -0.03em (-0.04em at display size). No custom font is loaded or embedded. The panel inherits Orca's `--app-font-family`; the Strategy board shows Geist because Orca supplies it. Numerals are tabular. Section labels are 11 px uppercase with .06em tracking.

Cards use 10 px radii, controls 8 px, pills 999 px, and primary actions 44 px. The Strategy board preserves the denser shipped 8 px cards and 32 px actions. In `style.ts`, body typography and tabular numerals live on `body`, section labels on `h2`, radii on `.card`, `.list` and buttons, and actions on `.actionbar`. The current `.brand` is weight 600 with positive .01em tracking; repository logos follow the wordmark definition above.

## Components

| Component | Reference board | Implementation today |
| --- | --- | --- |
| Usage meter with pace tick | Overview, Setup (last known) | `.meter`, `.fill`, `.pace` in `style.ts`; `overview.ts` |
| Ranked executor rows | Overview; choices in Delegate | `.provider`, `.rank`, `.list`; `delegate.ts`, `client.ts` |
| Status pills | Overview, Delegate, Strategy | `.pill`, `.good`, `.warn`, `.bad` |
| Attention cards | Overview | `.attention`, `.task-goal`; `overview.ts` |
| Step list | Setup | `.step`, `.step-num`; `setup.ts` |
| Last-known dashed card | Setup | `.last-known`; `setup.ts` |
| Info note | Setup; neutral note in Delegate | Boards |
| Sticky action bar | Overview, Setup, Delegate, Strategy | Boards |

## Voice and placement

Use plain sentences that explain the state and next step: “You're on pace for the week.” “The service is running.” “Nothing needs attention.” Name the executor, remaining budget and reset when useful; reserve uppercase for section labels.

Where it shows up: app header and empty states, the desktop app icon, the installer's output, and release pages. The repository header and social preview extend that identity.

Regenerate repository logos and the social preview with `bun run brand:render`. It loads no fonts. Logos retain SVG text so the wordmark uses the local system sans face.
