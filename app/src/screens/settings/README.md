# U3 settings screens

Import `screens/settings/index` explicitly. The legacy `Settings.tsx` file still exists, so a bare `screens/settings` import can resolve to that file on case-insensitive filesystems.

Mount inside the existing `TaskContext.Provider`:

| Route | Component |
| --- | --- |
| `#/settings` | `SettingsGeneral` |
| `#/settings/<section>` | `SettingsGeneral section={section}` |
| `#/settings/hosts` | `RemoteHosts` |
| `#/settings/hosts/<alias>` | `HostDetail alias={alias}` |
| `#/settings/add-executor` | `AddExecutor` |

Pass the `host` query parameter to `AddExecutor host={host}` for “Add executor here”. The screens register their token-based constructed stylesheet on mount; the shared build and stylesheet need no edits. `initialData` is optional preloaded data for rendering before requests complete. The API remains authoritative after mounting.

Jobs use store events plus `job.get` polling. Host detail also recovers retained jobs with `job.list`. The executor draft preserves the service-returned id and job id across reloads. Full-session opt-in is omitted because the current `host.set` operation schema does not expose it.
