# Proposal: a panel-callable plugin command action

Draft for review. Not posted.

## Motivation

Pacer's Orca worker reads budget and task state through the v2 API, using HTTP
or a stdio child. Panel buttons still send terminal text into a pacer console
because the panel cannot call its worker. A panel-to-worker command action
would remove terminal-text injection as a command transport and let the panel
receive the command's result directly.

## What exists today

- Orca host API v0 exposes only `workspace.readContext`, `terminal.sendText`
  and `notifications.show` to panels.
- Plugin workers register command handlers with `commands.register`.
- Panels cannot invoke those handlers through the host API or read plugin
  storage. See the [panel commands decision](../decisions/2026-10-14-orca-panel-commands.md).

## Pacer's current workaround

Buttons send a `: pacer '<json>'` line through `terminal.sendText` to a live
pacer console in the worktree. The console runs mapped commands as v2
operations. This requires a console terminal and routes results to console
output instead of returning them to the panel.

## Proposal: invoke an owned plugin command

Add a panel-callable host action:

```ts
plugin.invokeCommand({ id, args })
// id: a command ID registered by this plugin through commands.register
// args: JSON arguments passed to the registered handler
// result: Promise resolving to the handler's JSON result
```

For example, a panel could invoke `plugin.invokeCommand({ id: "refresh-status",
args: {} })` and receive the registered handler's result. The host resolves the
command within the calling panel's plugin, invokes its worker handler, awaits
completion and returns the result through the existing panel action/result
bridge. Unknown commands, unavailable workers and handler failures return
action errors to the panel rather than falling back to terminal text.

## Capability and limits

- Add the capability `commands:invoke-own`, requiring plugin consent before
  panels may use the action. It grants invocation only of commands owned by
  the calling plugin, with no cross-plugin target parameter.
- Reuse `PANEL_MESSAGE_MAX_BYTES` for the serialized request and result size
  limit. Reject oversized payloads before dispatch or return.
- Reuse `PANEL_MESSAGE_RATE_LIMIT` for invocation rate limiting through the
  panel bridge. Invocation must not bypass the existing panel message budget.
- Require JSON arguments and results; do not expose worker objects or arbitrary
  function names. Existing host capability checks still apply to host actions
  performed by the handler.

## Security considerations

Bind ownership to the authenticated panel context, not caller-supplied plugin
identity. Require a registered handler and the new consented capability; this
action does not grant shell, network or storage access to panels. Keep the
panel sandbox and its existing content security policy unchanged.

## Compatibility

The action and capability are additive. Plugins should detect support before
using the action and retain their existing console workaround on Orca versions
that do not provide it. Once available, pacer can route panel commands to its
worker and retire terminal-text injection.

---

Draft for the user's review. Not posted.
