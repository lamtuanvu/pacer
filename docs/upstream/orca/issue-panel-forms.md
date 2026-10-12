<!-- New issue, template: Feature request -->
<!-- Title: [Feature]: Plugin panels silently block form submission — allow forms or document it -->
<!-- Status: draft for review. Not posted. -->

### Problem or use case

**Summary:** in a plugin panel, clicking a form's submit button does nothing at all. No `submit` event fires, nothing is logged and no error is shown. The panel iframe is `sandbox="allow-scripts"` without `allow-forms`, and its CSP has `form-action 'none'`, so the browser blocks submission before any script sees it.

I lost a good while to this while building a plugin (pacer, a usage-budget and delegation tool). Its Delegate form and its "start an agent session" form used `<form>` with a submit button and a `submit` listener that calls `preventDefault()` and posts a bridge action. Everything worked in a normal browser and in tests. In Orca 1.4.224 the buttons were dead. Plain `type="button"` controls with click listeners worked fine.

Two related details make it harder to spot:

- `required` and other native validation don't help either. The validation bubble doesn't appear, so an empty required field also produces a click that does nothing.
- Nothing in the plugin docs or the example panel (`examples/plugins/hello-orca`) mentions it.

### Proposed solution

Either of:

1. Add `allow-forms` to the panel sandbox. With `form-action 'none'` still in the CSP, a form can't navigate or post anywhere, but the `submit` event fires, so plugins can handle it in script as on any web page.
2. If forms should stay blocked, document it in the plugin panel docs (forms never submit; use button click handlers). Optionally, log a console warning in development-path panels when a form submission is blocked.

### Alternatives or additional context

The workaround is to avoid `<form>` submission entirely: `type="button"` plus click handlers, and Enter handled with a `keydown` listener. That's easy once you know. The cost is entirely in discovering it.

### Operating system

macOS

### Orca version

1.4.224
