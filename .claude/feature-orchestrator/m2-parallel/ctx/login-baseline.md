# Task: is the single-use login double request pre-existing on main?

Live validation of the integration branch at 0835c8003 observed the following (see /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration/.work/reviews/live-live-web.md, and the evidence at .work/live/live-web-final/auth-goto.json, auth-network.json and auth-snapshot.json in that worktree):
- the fresh single-use login URL from the live harness was requested twice in Orca's built-in browser;
- the first request returned 200 and the second returned 403, and the browser landed on the expired-link page;
- navigating to /app/#/settings recovered the cookie session.

The redemption code in src/serve/app-routes.ts is the same on origin/main and at that head.

## Steps
1. Create a scratch worktree at origin/main 54ffba85d under /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/login-baseline: `git worktree add --detach`. Run `bun install` if needed.
2. In it, start a live session with `bun run live up` and the default TypeScript front door. That needs no cargo build. Follow docs/testing/live-validation.md. Use your own session id, login-baseline-main.
3. Sign in exactly the way the integration session did: get a fresh single-use login URL from the harness, open it in a new isolated Orca built-in browser profile, and record the URL sequence and network requests, the same evidence as the auth-*.json files. Does the auth URL get requested twice, and do you see 200, then 403, then the expired page?
4. Try to find the cause from the evidence and the code: src/serve/app-routes.ts redemption, the setup or first-run page's redirects or reloads, and the browser's prefetching. Then decide:
   - **pre-existing on main:** the same double request happens at baseline;
   - **introduced:** baseline signs in cleanly. In that case, name the likely integration change, for example in the app assets or setup routing.
5. Stop the session and delete the profile. Remove the scratch worktree with `git worktree remove --force`.

Never touch the maintainer's real pacer install, ~/.pacer, the com.pacer.serve service or launchd label, port 4317 or the model ports. Do not commit anything.

Write the report to /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/login-baseline.md, covering the baseline session's Summary line, the request sequence compared with the integration evidence, the cause analysis, the verdict (pre-existing or introduced), and cleanup. Report with orca orchestration worker_done. Always end with worker_done.
