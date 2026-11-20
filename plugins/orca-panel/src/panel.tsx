// No build step: Orca strips the types and compiles the JSX when the panel loads.
// Placeholder surface for the worker's pacer protocol: connected state and attention count
// only. The real attention queue (actions, confirm flow, labels) is the next task's work.
import { atom, Heading, plugin, read, set, Stack, Text, type PanelContext } from 'orca'
import type { PanelSnapshot } from './protocol'

/** What the worker last reported; null until it answers. */
const snapshot = atom<PanelSnapshot | null>(null)

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('pacer.changed', (payload) => set(snapshot, payload.snapshot)))
  void plugin.request('pacer.snapshot').then((answer) => set(snapshot, answer))
}

export default function Panel() {
  const value = read(snapshot)
  const heading =
    value === null ? 'Pacer' : value.connected ? (value.scope === 'repo' ? value.repoLabel ?? 'Repo' : 'All repos') : 'Not connected'
  const detail =
    value === null
      ? 'Loading'
      : value.connected
        ? `${value.attention.length} need${value.attention.length === 1 ? 's' : ''} you`
        : 'Start pacer serve to see what needs you here.'
  return (
    <Stack gap="md">
      <Heading>{heading}</Heading>
      <Text muted size="xs">
        {detail}
      </Text>
    </Stack>
  )
}
