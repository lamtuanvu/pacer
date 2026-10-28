# ADR 0011: Desktop hands a validated session file to the user's editor

Status: Proposed, 2026-10-28. Amends [ADR 0009](0009-terminal-file-viewer.md).

## Context

ADR 0009 gave terminal file links a read-only viewer backed by a bounded service read, and stated that no editor or shell command is added. The viewer cannot show binary or oversized files, and users often want the file in their own editor at the linked line. The maintainer decided to amend ADR 0009 to allow that hand-off on the desktop. Terminal text and OSC 8 targets stay untrusted, and so does the web page that renders them.

## Decision

This ADR narrows ADR 0009's "No editor or shell command is added" to one desktop-only exception. The rest of ADR 0009 is unchanged.

1. **Resolution.** The service adds the read-only operation `session.file.resolve { id, attempt, reference }`. It applies the same rules as `session.file.read`. The reference must belong to the stored working directory of the current local attempt. It must name a regular file inside that workspace, outside Pacer's state directory, and be reached by the descriptor-relative `openat` walk with `O_NOFOLLOW` on each component, so symlinks are refused. The size and UTF-8 limits do not apply, because their purpose is to let binary and oversized files be handed off. The operation returns `{ root, path, absolute, dev, ino, line?, column? }` and never opens or launches anything.
2. **Desktop command.** The desktop shell adds the IPC command `open_session_file { id, attempt, reference, action: "open" | "reveal" }`. It is granted only to the main window on the active service origin, and it checks the caller's label and origin like the other commands. The page never passes a file-system path to native code. The shell calls `session.file.resolve` with its own service session and validates the response: absolute paths, `absolute` equal to `root` joined with `path`, and no `..` components. Immediately before launching, it repeats the `O_NOFOLLOW` walk from `root` and requires the same `dev`/`ino` regular file.
3. **Open.** If the user has configured an editor, the shell runs it. The editor is configured in `$PACER_HOME/desktop/editor.json` as `{ "command": ["/absolute/program", "arg", "{path}", ...] }`. No API operation or page can write this file. The shell reaches it from `$PACER_HOME` without following symlinks. The file, `$PACER_HOME/desktop` and `$PACER_HOME` must each be owned by the current user and not writable by group or others, and the file must be at most 64 KiB. A file that fails these checks is an error, not a fallback to the default. The program must be an absolute path without placeholders. `{path}`, `{line}` and `{column}` are replaced inside individual argument elements; one element never becomes several, and the line and column default to 1. The shell spawns this argument vector directly, with no shell, null stdio, `/` as the working directory and no `PACER*` environment variables. If no editor is configured, the shell uses the OS default text editor. On macOS this is `/usr/bin/open -t <path>`, which picks the LaunchServices text editor rather than the file type's handler, so `.command`, `.terminal` or `.app` targets are never launched. Linux has no default, because `xdg-open` chooses a handler by content type and may run it, so Open is offered there only with a configured editor. Other platforms report that the action is unsupported.
4. **Reveal.** On macOS, Reveal in Finder uses `/usr/bin/open -R <path>`. On Linux, the action opens the containing directory.
5. **Capability.** The desktop command `host_file_actions` reports which actions the shell supports, along with the platform's label for reveal. On Linux, Open is reported only when an editor is configured. The app shows Open in editor and Reveal only when that command answers. Browser clients and older shells never receive the capability, so they render no button (UI-13).

## Alternatives considered

- **Opener plugin `open_path`, or `xdg-open`, with the file type's default handler.** Rejected because the handler for executable types runs the file. A `.command` file written by an agent would start in Terminal, and on Linux an HTML or launcher file could run too.
- **An editor command in `config.toml`.** Rejected because service operations can write config. A compromised page could then name any program and have the desktop run it.
- **Passing the resolved path from the page to native code.** Rejected because the page renders untrusted terminal output. Native code accepts only a session reference and resolves it itself.

## Consequences

- Desktop users can open any regular workspace file, including binary or oversized ones, in their own editor or reveal it in the file manager. Browser users keep the read-only viewer.
- The desktop gains one launch path, which falls under SEC-5 and SEC-8. It needs a security review whenever it changes.
- A swap that lands after the final identity check and before the editor opens the path remains a narrow race. The editor only opens a file, and on macOS the default handler never executes one.
- Remote and Orca sessions remain excluded, as they are for the read.
- The API change is backward compatible. It adds one v3-only operation with regenerated protocol docs and Rust types.
