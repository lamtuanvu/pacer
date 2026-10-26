# Dispatcher settings consolidation

## Intent

The user should find the entire work assignment policy in one Settings page. Separate Strategies, Routing and Dispatcher navigation items expose internal configuration boundaries and obscure the relationship between them.

## Approaches

- Keep three pages and improve cross-links: smallest change, but preserves the confusing navigation.
- Put profile switching and executor eligibility on the Dispatcher page: preserves existing service operations while giving the decision flow one home. **Chosen by the maintainer.**
- Replace the strategy and routing data models: broader migration and compatibility risk with no benefit to the requested UI change.

## Behavior

Settings → Dispatcher shows the default planner, active decision engine and preview, saved global profiles, global task-kind executor rules, and per-repository executor overrides. Saved profiles remain available as a way to switch the full global policy; project overrides remain independent and take precedence over global routing for their repository. The page uses distinct headings and short explanatory copy so users can see eligibility before ranking.

Remove Strategies and Routing from Settings navigation and the General shortcuts. The rail quick access names Dispatcher, keeps fast profile switching, and offers one link to its Settings page. Existing Settings URLs and service-provided links for the former pages redirect to Dispatcher, preserving repository and scope query parameters. The API and saved configuration stay compatible. Update user documentation and tests. Validate the web and native Settings surfaces and retain before/after visual evidence.
