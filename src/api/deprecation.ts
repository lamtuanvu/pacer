/**
 * Protocol 2 deprecation (A4): `/v2` is deprecated in 0.18.0 for removal in
 * 0.19.0. HTTP responses to `/v2` paths carry the RFC 9694 `Deprecation` and
 * successor `Link` headers so 2.x callers can find the successor. The
 * `Sunset` header is not sent until the removal release (0.19.0) is dated.
 * Protocol 3 responses are never annotated.
 *
 * The header values are duplicated in `crates/server/src/serve/deprecation.rs`
 * and must stay string-equal; `test/api-v2-deprecation.test.ts` compares them.
 */
import type { Ctx } from "../types";

/** Release that removes protocol 2 (the next release after 0.18.0). */
export const V2_REMOVAL_RELEASE = "0.19.0" as const;

/** Unix seconds of 00:00 UTC on the A4 merge date (2026-11-22). */
export const V2_DEPRECATED_AT = 1_795_305_600 as const;

/**
 * The RFC 9694 `Deprecation` and successor `Link` headers attached to every
 * protocol 2 response. The `Sunset` header is deferred until the removal
 * release (0.19.0) is dated, per the master program plan.
 */
export const V2_HEADERS: Readonly<Record<"Deprecation" | "Link", string>> = {
  Deprecation: `@${V2_DEPRECATED_AT}`,
  Link: `</v3/hello>; rel="successor-version"`,
};

/** True for a request path that speaks protocol 2. */
export function isV2Path(pathname: string): boolean {
  return pathname === "/v2" || pathname.startsWith("/v2/");
}

/** Decorates a protocol 2 response with deprecation headers; other responses pass through. */
export function withV2Deprecation(pathname: string, response: Response): Response {
  if (!isV2Path(pathname)) return response;
  for (const [name, value] of Object.entries(V2_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export type { Ctx };