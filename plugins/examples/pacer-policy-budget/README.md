# Observational running-task policy

This unbundled example vetoes `delegate` when the visible running-task count
reaches `N` (default **3**). It permits route and review decisions. It declares
only `tasks.read`, `events.subscribe`, `config.get` and `log`; it cannot create,
patch or stop tasks, launch processes, or read credentials.

Use Pacer protocol 1.5 with negotiated observation support and Bun on `PATH`.
From this repository after installing its dependencies:

```sh
bun run plugins/examples/pacer-policy-budget/build.ts
pacer_example_home="${PACER_HOME:-$HOME/.pacer}"
mkdir -p "$pacer_example_home/plugins/pacer-policy-budget/dist"
cp plugins/examples/pacer-policy-budget/pacer-plugin.json "$pacer_example_home/plugins/pacer-policy-budget/"
cp plugins/examples/pacer-policy-budget/dist/main.js "$pacer_example_home/plugins/pacer-policy-budget/dist/"
chmod +x "$pacer_example_home/plugins/pacer-policy-budget/dist/main.js"
pacer plugin enable pacer-policy-budget --yes
pacer plugin doctor pacer-policy-budget --json
```

Review the four requested capabilities before enabling. `--yes` grants them.
Enabling changes metadata; doctor or the first policy call starts the process
and establishes its subscription. A doctor command's process ends with that
command; a later host process establishes its own generation-bound subscription.
The example is never added to Pacer's bundled plugin list.

Merge the following keys into the existing strategy file, retaining other plugin
configuration and grants:

```yaml
plugins:
  policy:
    mode: closed
  config:
    pacer-policy-budget:
      N: 3
```

`N` must be an integer from 1 to 500, the bounded task-list observation range.
Every delegate check reads fresh running tasks, requesting at most `N` rows.
Events demonstrate observation and reset recovery; cached event counts never
authorize a delegate. A reset resubscribes and reads a fresh bounded snapshot.
Logs contain counts, not task goals or repository paths.

An explicit veto applies in both `open` and `closed` mode. Plugin failure or
invalid configuration is ignored in `open` mode and vetoes in `closed` mode.
The status surfaces expose the mode and enabled policy count; `closed` with zero
plugins is not a running-task limit.

This is an observational example, **not an atomic concurrency reservation**.
Concurrent admissions may observe the same count before either new task starts;
queued work is not counted, and task visibility follows the owner's authority.
Use host capacity/reservation controls for an authoritative concurrency limit.
No entitlement or license check is involved.
