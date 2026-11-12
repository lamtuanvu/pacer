import { expect, mock, test } from 'bun:test';
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';

/** The recording renders through the shared lazy terminal; capture its props instead of mounting xterm. */
const terminals: Record<string, unknown>[] = [];
mock.module('../app/src/term/LazyTerminal', () => ({
  LazyTerminal: (props: Record<string, unknown>) => {
    terminals.push(props);
    return h('div', { class: 'terminal-mock' });
  },
}));

const { AttemptPanel } = await import('../app/src/screens/workspace/Workspace');

const attempt = (over: Record<string, unknown> = {}) => ({ executor: 'codex', startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: '', ...over });
const id = 't-20261102-090145-e376';
const detail = (attempts: Record<string, unknown>[]) => ({ id, attempts }) as any;
const panel = (n = 0) => ({ id: `attempt:${id}:${n}`, task: id, kind: 'attempt' as const, attempt: n, title: `Attempt ${n + 1}` });
const render = (task: unknown, n = 0) => renderToString(
  h(TaskContext.Provider, { value: { api: {} as any, state: initialState() as any } },
    h(AttemptPanel as any, { panel: panel(n), task })),
);
const last = () => terminals.at(-1);

test('an ended attempt renders its recording read-only through the shared terminal', () => {
  const html = render(detail([attempt({ recording: true })]));
  expect(html).toContain('terminal-mock');
  expect(last()).toMatchObject({
    id: `${id}:0`,
    url: `/v3/tasks/${id}/session?attempt=1`,
    agent: 'codex',
    live: false,
    control: false,
    resize: false,
    autoControl: false,
    externalControls: true,
  });
});

test('an attempt without a saved recording keeps the no-recording placeholder', () => {
  const html = render(detail([attempt({ recording: false })]));
  expect(html).toContain('No recording was saved for this attempt.');
  expect(html).not.toContain('terminal-mock');
  // Attempt two of the same task uses the run directory one above its zero-based index.
  const second = render(detail([attempt({ recording: true }), attempt({ recording: false })]), 1);
  expect(second).toContain('No recording was saved for this attempt.');
});

test('an attempt index without a record says so instead of a generic message', () => {
  expect(render(detail([]))).toContain('No attempt recorded.');
  expect(render(detail([attempt({ recording: true })]), 3)).toContain('No attempt recorded.');
});
