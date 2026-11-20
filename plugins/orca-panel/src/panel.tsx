// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Heading,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  update,
  type PanelContext
} from 'orca'

/** What the worker last reported; null until it answers. */
const total = atom<number | null>(null)
/** A keyed atom: `persist: 'plugin'` keeps it across panel runs. */
const step = atom('step', 1, { persist: 'plugin' })

async function add(): Promise<void> {
  // Typed by src/protocol.ts; starts the worker if it is not running.
  const answer = await plugin.request('counter.add', { by: read(step) })
  set(total, answer.total)
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('counter.changed', (payload) => set(total, payload.total)))
  void plugin.request('counter.get').then((answer) => set(total, answer.total))
}

export default function Panel() {
  const value = read(total)
  const by = read(step)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Counter</Heading>
        <Badge tone="accent">{value === null ? '-' : value}</Badge>
      </Row>
      <Row gap="xs">
        <Button onPress={add}>Add {by}</Button>
        <Button variant="ghost" onPress={() => update(step, (n) => (n === 1 ? 10 : 1))}>
          Step {by === 1 ? 10 : 1}
        </Button>
      </Row>
      <Text muted size="xs">
        src/worker.ts keeps the total in storage. Edit either file and save: Orca reloads it.
      </Text>
    </Stack>
  )
}
