// No build step: Orca strips the types and compiles the JSX when the panel loads.
// Sidebar attention queue: snapshot + live pacer.changed, action buttons, confirm gate.
import {
  atom,
  Button,
  Callout,
  EmptyState,
  Heading,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Stack,
  Text,
  type PanelContext,
} from 'orca'
import type { AttentionAction, AttentionItem } from './pacer-client'
import type { PanelSnapshot } from './protocol'

/** What the worker last reported; null until it answers. */
const snapshot = atom<PanelSnapshot | null>(null)

/** Action waiting on an in-panel Confirm/Cancel; null when none is pending. */
const pending = atom<AttentionAction | null>(null)

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('pacer.changed', (payload) => {
      set(pending, null)
      set(snapshot, payload.snapshot)
    }),
  )
  void plugin.request('pacer.snapshot').then((answer) => set(snapshot, answer))
}

function scopeHeading(value: PanelSnapshot): string {
  return value.scope === 'repo' ? (value.repoLabel ?? 'Repo') : 'All repos'
}

function emptyTitle(value: PanelSnapshot): string {
  return value.scope === 'repo' ? 'Nothing needs you' : 'Nothing needs you across any repo'
}

/** Orca Button uses `tone` for danger; plan's "secondary" maps to outline. */
function actionTone(style: AttentionAction['style']): 'danger' | undefined {
  return style === 'danger' ? 'danger' : undefined
}

function runAction(action: AttentionAction): void {
  void plugin.request('pacer.act', { op: action.op, params: action.params })
}

function onActionPress(action: AttentionAction): void {
  if (action.confirm) {
    set(pending, action)
    return
  }
  runAction(action)
}

function ConfirmGate({ action }: { action: AttentionAction }) {
  const confirm = action.confirm!
  return (
    <Stack gap="sm">
      <Callout tone={action.style === 'danger' ? 'danger' : 'neutral'} title={confirm.title}>
        <Text>{confirm.body}</Text>
      </Callout>
      <Row gap="sm">
        <Button
          variant="solid"
          tone={actionTone(action.style)}
          onPress={() => {
            set(pending, null)
            runAction(action)
          }}
        >
          Confirm
        </Button>
        <Button variant="outline" onPress={() => set(pending, null)}>
          Cancel
        </Button>
      </Row>
    </Stack>
  )
}

function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <Stack gap="xs">
      <Text weight="medium">{item.title}</Text>
      <Row gap="sm" align="center" wrap>
        <Text muted size="xs">
          {item.detail}
        </Text>
        <Text muted size="xs">
          ·
        </Text>
        <RelativeTime at={item.since * 1000} format="short" muted />
      </Row>
      <Row gap="sm" wrap>
        {item.actions.map((action) => (
          <Button
            key={action.label}
            variant={action.style === 'danger' ? 'solid' : 'outline'}
            tone={actionTone(action.style)}
            onPress={() => onActionPress(action)}
          >
            {action.label}
          </Button>
        ))}
      </Row>
    </Stack>
  )
}

export default function Panel() {
  const value = read(snapshot)
  const waiting = read(pending)

  if (value === null) {
    return (
      <Stack gap="md">
        <Heading>Pacer</Heading>
        <Text muted size="xs">
          Loading
        </Text>
      </Stack>
    )
  }

  if (!value.connected) {
    return (
      <Stack gap="md">
        <Callout tone="warning" title="Not connected">
          <Text>Start pacer serve to see what needs you here.</Text>
        </Callout>
      </Stack>
    )
  }

  return (
    <Stack gap="md">
      <Heading>{scopeHeading(value)}</Heading>
      {waiting ? <ConfirmGate action={waiting} /> : null}
      {value.attention.length === 0 ? (
        <EmptyState title={emptyTitle(value)} />
      ) : (
        value.attention.map((item) => <AttentionRow key={item.id} item={item} />)
      )}
    </Stack>
  )
}
