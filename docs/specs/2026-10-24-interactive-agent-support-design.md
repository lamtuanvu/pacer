# Interactive support for Claude Code, Codex and OpenCode

Date: 2026-10-24. Status: approved by the maintainer in conversation; implementation and validation in progress.

## Intent and scope

Pacer's primary work entry must offer functional persistent native-terminal conversations for Claude Code, Codex and OpenCode. Installing a newer CLI must not disable an agent merely because its version differs from the version used for release validation. Support means launch, subsequent turns, attachment delivery, model and account selection, disconnect/reconnect, stop, and resume of the same native conversation in the same workspace.

The maintainer selected completing the existing native-terminal adapters. The scope includes host lifecycle gaps that prevent those adapters from working. Other agents retain explicit unsupported reasons until implemented. Remote interactive sessions remain outside this change; existing delegated execution remains supported independently.

## Approaches

1. Complete the bundled agentSession plugin and its existing host integration (selected). Preserve the native terminal, permission prompts and versioned service contracts. Extend capability reporting and lifecycle handling only where needed.
2. Introduce structured conversation backends per agent. This would replace the selected native-terminal experience and introduce a larger transport and rendering project; deferred.

Removing the version restriction without implementing agent launch and recovery is insufficient.

## Responsibilities and compatibility

The service owns admission, account environment resolution, workspaces, private attachments, process supervision and durable task state. Agent-specific argument construction and attachment mechanisms stay in the bundled plugin, with no host fallback. Existing API and plugin fields remain compatible; any additional inputs or results are optional and documented through generated schemas.

Capability decisions use the implemented native mechanisms. The implementation will probe installed CLI help when necessary to distinguish interface generations and report missing required mechanisms explicitly. A validation version is evidence metadata, not an exact-version allowlist. Missing executables, failed probes, unavailable accounts and unsupported agents receive distinct actionable reasons. The same effective account environment must be used for preparation and launch without reading native credentials.

CLI-generation detection and the smallest appropriate additive protocol shape are builder decisions, supported by tests and installed-help evidence. Failed or inconclusive required capability probes must not be reported as supported. No unverified version cutoff is to be invented.

## Agent behavior

### Codex

Keep the native interactive CLI with the workspace and private attachment directories, selected model, native launch image arguments, and ordinary approval/sandbox behavior. Resume by the persisted native session ID without replaying the initial request or attachments. Preserve the existing identity hook and verify identity capture on the current installed CLI. Support compatible installed releases without requiring an exact version match; optional flags must be chosen according to detected interfaces.

### Claude Code

Launch interactive Claude in the selected workspace and named-account environment, with the chosen model and explicit private-directory access. Assign a UUID for a new conversation through its native session-ID option and persist it before process launch. Resume with the native resume option and that UUID; do not pass a new-session flag or replay the initial prompt. Preserve native permission prompts.

Initial files and images use explicit readable path references unless a supported native attachment mechanism is demonstrated. Do not treat Claude's remote file-ID download option as a local attachment option. Keep truthful per-agent attachment capability reporting.

### OpenCode

Use a private native server so the process inherits the selected account, endpoint configuration and model environment. Reuse the existing inline model configuration rather than adding an unsupported TUI model flag. Preserve native approval behavior rather than enabling blanket auto-approval.

Use the supported native session identity mechanism to create and persist an unambiguous identity and resume that same session. Never resume the most recent unrelated session. Inspect the installed session/API interface to settle identity creation without inventing an unsupported ID format. Files and images use explicit path references unless a native launch mechanism is verified. The existing model-override exclusion is removed once this path is covered by tests and live evidence.

## Shared lifecycle and attachments

Persist identities for fresh and resumed conversations in both the run record and conversation state. A completed assistant turn leaves the process and conversation available. Closing a viewer does not stop the agent. Reconnection restores terminal access; explicit end stops the owned process and retains changes and output. Resume keeps the same agent/account/workspace and reports missing identity or native history precisely.

Initial attachment references are included only on a fresh launch. Later attachments require explicit user insertion/submission and must not send Enter or replace a partly typed prompt. Attachment files stay in private storage outside Git. Directory grants and agent access must be verified for each adapter. Large prompts continue to use the private request-file mechanism.

## Validation and acceptance

Automated tests cover each agent's fresh/resumed argument vector, identity persistence, account/model environment, literal prompts and paths, attachments, failed probes and unknown agents. Include compatible version changes and avoid tests that merely pin a single installed version. Exercise preparation through the service and ensure unavailable options show their actual cause.

Run affected tests, typecheck, required generated-artifact freshness and relevant project checks. Use the CT-11 live harness and disposable repository for real-agent validation of all three agents: start, initial request, second turn, attachment access, identity persistence, reconnect, stop and resume retaining context. Exercise applicable CLI/API, TUI, web and native desktop surfaces; capture evidence and mark unavailable surfaces UNVERIFIED. Never use the user's working checkout for live execution or copy credentials into evidence.

Obtain independent repository, architecture/protocol/security and QA review proportionate to the changes, plus UI/accessibility review if presentation changes. Resolve blockers, rerun affected checks and independently review final fixes. Reports belong under .work/reviews/; live reports under .work/live/. Completion requires the project's required review and validation evidence.

## Governance

Constitution version 0.12.0, with established constraints retained and proposed amendments not treated as adopted. Applicable sources: .project/rules/architecture.md (ARCH-1–5, ARCH-8–9, ARCH-12–14), api-protocol.md (API-1–5), security.md (SEC-1–7), code-and-testing.md (CT-1–7, CT-11), repository.md (including REPO-10 as required by AGENTS.md), and ui.md for any presentation changes. Reviewer definitions come from .project/reviewers/{architecture,protocol-compat,security,qa,ui-accessibility}.md. Existing interactive-conversations ADR remains the architecture baseline; update its support description and user documentation to reflect the delivered behavior and actual validation coverage.

No governance exception, merge, publication or deployment is requested by this design. Precise source organization, probe caching and error wording are builder decisions. Native mechanisms, rather than inferred feature parity, determine agent-specific capabilities.
