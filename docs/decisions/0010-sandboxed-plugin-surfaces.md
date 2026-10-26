# ADR 0010: Sandbox plugin surface documents

Status: Proposed for the SP11 implementation PR. The maintainer adopts this decision by merging that PR.

## Context

The original SP11 design placed plugin HTML and scripts under `/app/plugins/<prefix>/` with the app's normal origin and CSP. A plugin script on that origin could read the app's session and call privileged service operations. A path check followed by a pathname read could also follow a symlink swapped between the check and open.

## Decision

- Keep the authenticated entry URL under `/app/plugins/<prefix>/`. Only an enabled, granted installed plugin with a unique prefix receives a surface.
- Redirect an authenticated entry request to a one-hour HMAC-scoped URL beneath `/_s/<ticket>/`. The ticket authorizes static `GET` and `HEAD` for that plugin only; it never authorizes API operations. Relative resource URLs stay beneath the scoped path, so browser requests still work when sandboxing omits app cookies. The public Rust listener forwards only bounded ticket-shaped static paths; the core verifies the MAC and current plugin grant on every request.
- Send `Content-Security-Policy: sandbox allow-scripts` without `allow-same-origin`. Plugin documents get an opaque browser origin. Their scripts cannot read app cookies or API responses. The policy also denies network connections, forms, top navigation, popups and base URL changes. `Referrer-Policy: no-referrer` and `Cache-Control: no-store` prevent ordinary token propagation and caching.
- Open each directory and file relative to a pinned descriptor with `O_NOFOLLOW`. Read bounded regular files from the opened descriptor, then verify the plugin folder still names the selected inode. Reject symlinks, traversal, unsupported file types, oversized files, changed files and ambiguous prefixes.

The token URL is a read capability for plugin-authored static files. It must not be accepted by any API or task operation. Static files must not contain secrets.

## Consequences

An external plugin UI may run scripts, but only with opaque-origin authority. Plugin pages use relative asset paths. Disabling a plugin immediately invalidates its scoped URLs. Reloading the authenticated entry URL obtains a fresh ticket after expiry. The app will embed the surface as a sandboxed view in a later SP11 UI slice; this decision does not itself add the Settings screen or TUI summary.
