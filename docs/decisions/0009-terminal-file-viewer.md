# ADR 0009: Terminal file links use a bounded service read

Status: Proposed, 2026-10-27

## Context

Pacer's built-in terminal displays agent output but does not yet give file paths a reliable destination. Browser and desktop clients need the same file view, while terminal text and OSC 8 targets are untrusted. A client cannot safely resolve a relative path using its own current directory or read a remote/session workspace directly.

## Decision

The local service exposes an authenticated, read-only, versioned operation for a file named by a specific local session attempt. It resolves the reference against that attempt's stored working directory. The read is bounded to regular text files inside the workspace and excludes Pacer's state directory. A native descriptor-relative `openat` traversal with `O_NOFOLLOW` on each component avoids path-swap reads; symlink paths are rejected. The operation returns text and metadata, never an arbitrary file-system capability. A stale attempt or unsupported host returns a typed error.

The built-in xterm client classifies explicit OSC 8 targets, HTTP(S) URLs, and file references. HTTP(S) opens externally; local `file://` targets use the same bounded operation; unknown schemes remain inert. A read-only Preact viewer shows source and optional Markdown/HTML previews. HTML preview has an opaque sandboxed origin and no script, form, or network privileges. No editor or shell command is added.

## Consequences

The service gains a narrow workspace read capability with tests and security review obligations. Local built-in sessions can inspect files from browser and desktop. Orca continues to own its separate terminal; remote sessions need a separate remote file-read design. HTML previews without local assets or scripts may differ from the running page, which the UI explains. API additions are backward-compatible and require regenerated protocol docs.
