// The native shell calls this expression with a render function name and its payload.
// WebKit can report the bundled document loaded before its deferred shell script runs,
// so a render that arrives first waits for the load event, which follows deferred
// scripts. Only the newest delivery per function runs: an older waiting one never
// replaces a later state. The payload stays in this closure, never on window.
((name, data) => {
  const seqs = window.__pacerShellDeliveries ||= {};
  const seq = seqs[name] = (seqs[name] || 0) + 1;
  const run = () => { if (seqs[name] === seq) window[name]?.(data); };
  if (typeof window[name] === 'function') run();
  else if (document.readyState !== 'complete') window.addEventListener('load', run, { once: true });
})
