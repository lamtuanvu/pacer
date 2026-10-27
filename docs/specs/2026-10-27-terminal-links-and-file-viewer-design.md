# Terminal links and file viewer design

## Intent

People using Pacer's built-in session terminal should be able to follow web links and inspect files named in agent output without copying text or guessing which workspace the agent used. A file location such as `src/main.ts:42:7` should land on the named line. Markdown and HTML should have rendered previews as well as source. The user delegated the remaining implementation choices after requesting a UI design prompt and confirming that HTML preview matters.

## UI design prompt

> Design a compact, accessible file viewer for Pacer's session workspace. A user clicks a file path in live terminal output, such as `src/main.ts:42`, `README.md`, or `public/index.html:18`, and a read-only viewer opens without ending or taking control of the session. Show the filename, workspace-relative path, file type, and an obvious Close or Back to terminal action. Code and text show selectable source with line numbers, find, horizontal scrolling, and a clear highlight at the requested line and column. Markdown and HTML have Source and Preview tabs; the preview must be visually useful and the source always reachable. HTML preview is isolated from Pacer and clearly labels blocked scripts or external resources. External HTTP(S) links open in the system browser or a new browser tab. Design desktop and 375 px layouts in light and dark themes, including loading, missing file, unsupported file, large file, and changed-on-disk states. Preserve the current session terminal and control status, avoid nested interactive targets, use Pacer's design system and tokens, and show keyboard focus and screen-reader labels. Deliver annotated screen states and interaction notes, including what a click does while the agent is actively typing.

## Goals

- Recognize explicit OSC 8 hyperlinks and plain HTTP(S) URLs in the built-in xterm terminal.
- Recognize common source file references, including relative and absolute paths and optional line and column, without interpreting arbitrary prose as a path.
- Resolve relative paths against the session attempt's working directory, not the browser's URL or the user's current shell directory. Bind each read to the attempt shown in the terminal.
- Keep file opening read-only and independent of terminal control ownership.
- Open code and text at a requested line; offer source and rendered preview for Markdown and HTML.
- Give clear, non-destructive feedback when a target is missing, inaccessible, too large, binary, or outside the allowed workspace.

## Non-goals

- Editing files, language services, Monaco, debugger functions, or a repository explorer.
- Executing commands derived from terminal output.
- Treating arbitrary URI schemes or path-looking text as trusted actions.
- Rendering files from Orca's own terminal inside Pacer; Orca owns that surface.

## Constraints

- `pacer serve` owns file reads and path resolution. Clients use a versioned API operation (P1, ARCH-1/2, API-1/4).
- File access is confined to the selected local session workspace after canonical resolution, including symlinks and race checks on the opened file. Reads are bounded and text-only. The Pacer state directory is explicitly excluded even if it sits inside a selected workspace. A session whose workspace is inside a Pacer task worktree, `<pacerHome>/worktrees/<repo>-<hash>/<task id>`, can read files there; the per-repo and `worktrees` directories themselves, a symlinked `worktrees` directory and the rest of the state directory stay excluded. No native credentials or private Pacer state may be exposed (SEC-1/2/4/5).
- HTML preview runs in a sandboxed, opaque-origin iframe without scripts, forms, top navigation, same-origin privileges, or external network resources. Inline CSS may render. Source remains available. This is the initial interpretation of the user's request for an important preview; richer active-page preview is a separate capability.
- Markdown preview does not execute raw HTML. Its links use the same destination policy as terminal links.
- The current app and terminal chunk budgets, shared UI patterns, accessibility, screenshots, review reports, and CT-11 live validation remain applicable (UI-1–3/8–25, CT-11, REPO-10).

## Approaches

1. **OS/editor handoff only.** Smallest interface, but browser users and remote viewers have no reliable file destination; line targeting varies by installed editor.
2. **Read-only Pacer viewer with optional external handoff (selected).** One consistent destination for built-in sessions, including browser and desktop; adds a bounded file-read operation and a focused viewer UI.
3. **Embedded full editor.** Could support editing and language services, but exceeds the requested inspect-and-preview task and Pacer's small bundle goals.

## Behavior and architecture

The xterm adapter assigns link precedence: explicit OSC 8 target, HTTP(S) text, then file reference. HTTP(S) targets leave Pacer. An explicit OSC 8 `file://` target is decoded once and opened internally only when its authority is empty or `localhost` and its canonical file falls inside the bound session workspace; other file authorities and unknown schemes remain inert text. `mailto:` remains inert in the first version. Link activation requires an explicit pointer or keyboard action and does not send input to the agent. Hover and focus indicate the destination and kind; a link's displayed label never overrides target validation. The click affordance uses a modifier while the user controls the terminal so ordinary text selection and input are unaffected.

The service maps task ID and attempt number to the selected attempt and its stored local `run.workdir`. `task.session` exposes that number, and the terminal sends it with a file read; if the task has resumed or retried, the service refuses the stale request. File references are decoded conservatively, normalized, and resolved against that directory. Canonical target and workspace root must preserve containment. A race-safe reader opens the canonical workspace root as a directory descriptor, verifies that descriptor's identity matches the selected attempt's workspace root, traverses each relative component with `openat` and `O_NOFOLLOW` on macOS/Linux, rejects symlinks and non-regular targets, and reads only through the final descriptor after `fstat`; it never performs a path-based second open after containment checking. This deliberately treats symlink paths as unavailable even when they resolve inside the workspace. The Pacer state directory is denied by canonical path before traversal. The operation returns a bounded UTF-8 text result with canonical workspace-relative path, content type, size, modification identity, and requested line/column. Missing and rejected targets have typed errors. Large or binary files show an explanation with Copy path rather than an empty viewer. A changed-on-disk reread is explicit and does not silently replace the text someone is inspecting.

The file viewer is a panel in both routes that show a built-in session terminal. Opening and closing it preserves the live terminal instance and its scrollback, control state, and input focus. Source is a selectable, scrollable read-only rendering; syntax color is a lazy enhancement with a narrow language set, not a prerequisite for navigation. Markdown uses `markdown-it` with raw HTML disabled. HTML preview uses a sandboxed iframe with a restrictive policy; relative local assets are omitted in the first version, and the UI explains that limitation. A future asset-serving design could add them without broadening the terminal link parser.

External HTTP(S) URLs open a new browser tab; the native shell may hand them to the system browser through its existing navigation policy. The UI never navigates the session page itself to an untrusted terminal URL. Browser file viewing and desktop file viewing share the same operation and component.

## Implementation boundary and verification

First implement and test the pure link classifier and file locator, then the authenticated read operation, then the terminal integration and viewer. Verify link precedence, wrapped lines, punctuation, path names with spaces, line/column parsing, symlink escape, removed files, binary and oversized content, stale attempts, HTML isolation, keyboard focus, terminal persistence, light/dark and narrow layouts. Run affected tests, typecheck, UI checks and build; perform live validation with the harness and independent repository, UI/accessibility, QA, security and protocol review before claiming completion.

## Builder choices

- Use the existing Preact design system for controls and layout.
- Prefer a small lazy syntax highlighter only if the built artifact stays under the current per-chunk limit; plain escaped text remains the fallback.
- Treat static HTML preview as the first supported preview. Scripts, external requests, and local asset loading require explicit new design and security review.
