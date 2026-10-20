# 0001: Persistent per-project executor policy

Status: Accepted for implementation; maintainer approval of issue #190 plan, 2026-10-20.

## Context

Global task-kind rules and pacing do not express a persistent repository allowlist or strict project order. Independent routing, queue and retry paths must agree.

## Decision

Store revisioned project policies in `project-strategies.json` under PACER_HOME, independently of named strategies and the disposable repository registry. Reuse canonical repository identity and persist fully qualified runner account/host identities. A project list replaces global candidate selection and ordering, while preserving hard eligibility, capacity and the three-attempt bound. No override preserves the existing algorithm.

All clients use core operations. Writes require compare-and-swap revisions and atomic protected files. Routing rechecks revisions at attempt reservation; later policy edits do not stop an already committed attempt. Fresh retries and fallback must recheck. Corrupt policy data fails closed. Policy removal explicitly restores global behavior.

## Consequences

Strategy switching cannot silently widen a project allowlist. Removed runners remain unavailable references. Worktrees and clones sharing canonical origin share policy. Origin changes and moved originless repositories need explicit policy migration. A new Settings editor and CLI expose the same API; no interactive plugin or credential changes are needed.

See [the design](../specs/2026-10-20-per-project-strategy-design.md) for the complete precedence and concurrency contract.
