# Dispatcher settings UI

Status: Implementation detail for the maintainer-approved intelligent dispatcher design in `2026-10-24-intelligent-work-dispatcher-design.md`.

## Intent

The existing Strategies screen shows a pacing summary but hides the dispatcher. A user should be able to see who plans the current session, understand that a granted executor may plan child work, inspect the active account/model decision ladder, and preview its choice for a task. The screen must explain the relationship among project executor restrictions, legacy routing rules, and dispatch ranking.

## Approach

Add a dedicated Settings → Dispatcher page, linked prominently from Strategies. The service returns the active strategy name, session planner, effective dispatch config and whether it is explicit or built in. The page also reads the declared/observed model inventory and calls the existing read-only `dispatch.preview` operation. All recommendations come from the service; the client does not rank candidates.

An ordered step editor lets the user adjust capacity, task-kind match, candidate restriction, and ranking. Changes are validated with `strategy.preview`, saved as a new named strategy with `strategy.save`, then activated with `strategy.use`. This keeps the immutable default and avoids silently changing a live strategy. The UI presents the active configuration even when the `dispatch:` YAML section is absent, labeling built-in defaults accurately. Model declarations remain in executor configuration; observed model IDs are not silently authorized.

## Boundaries

- A global planner remains the default session planner. For managed work, any local executor with a valid attempt grant can request child work, and Pacer chooses the child executor. Remote child grants remain unsupported.
- A selected project strategy supplies the executor candidates for one repository. Without one, legacy Routing maps task kind to an executor list. The dispatcher ladder then ranks qualifying accounts/models from that list for the specific work attempt; its preview must expose exclusions and uncertainty.
- The page does not start work during preview or grant authority to an executor. It does not imply that a model's tier or actual identity was observed when merely declared.
- Older services without the required operations get an explicit capability message.

## Evidence

Verify effective defaults and explicit configuration through the API, save/activate through the existing strategy API, preview against a disposable repository, and browser render/focus at desktop and narrow widths. Follow UI-18, UI-24, CT-11 and REPO-10; keep screenshots and reports under `.work/` until attached to a PR.
