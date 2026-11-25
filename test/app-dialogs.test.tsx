import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { DialogForm, type DialogRequest } from '../app/src/ds/useDialogs';
import { Button } from '../app/src/ds/Button';

const request: DialogRequest = { title: 'Accept tasks', label: 'Accept tasks', message: 'Accept 2 tasks?\n\n• First (t-1) · Repo\n• Second (t-2) · Repo' };
function form(value = '', text = false) {
  const results: unknown[] = [], changes: string[] = [];
  const node = DialogForm({ request: { ...request, text }, value, change: next => changes.push(next), finish: result => results.push(result) });
  const content = node.props.children as any;
  return { node, content, results, changes };
}

test('confirmation modal displays the complete affected task list and explicit confirm/cancel controls', () => {
  const html = renderToString(form().node);
  expect(html).toContain('aria-label="Accept tasks"');
  for (const text of ['First (t-1) · Repo', 'Second (t-2) · Repo', '>Cancel</button>', '>Accept tasks</button>']) expect(html).toContain(text);
  expect(html).not.toContain('<textarea');
  const { content, results } = form();
  let prevented = false;
  content.props.onSubmit({ preventDefault: () => { prevented = true; } });
  expect(prevented).toBe(true);
  expect(results).toEqual([true]);
});

test('cancel and dialog dismissal decline the action', () => {
  for (const text of [false, true]) {
    const { node, content, results } = form('', text);
    node.props.close();
    const actions = content.props.children[2].props.children;
    expect(actions[0].type).toBe(Button);
    actions[0].props.onClick();
    expect(results).toEqual([text ? null : false, text ? null : false]);
  }
});

test('rejection modal has a labelled required text field, rejects whitespace and submits the entered reason', () => {
  for (const value of ['', '   ', 'Needs fixes']) {
    const { node, content, results, changes } = form(value, true);
    const html = renderToString(node);
    expect(html).toContain('>Rejection note</label>'); expect(html).toMatch(/<textarea[^>]*required[^>]*autofocus/); expect(html).toContain('for="field-');
    const input = content.props.children[1].props.children;
    input.props.onInput({ currentTarget: { value: 'Updated reason' } });
    expect(changes).toEqual(['Updated reason']);
    const submit = content.props.children[2].props.children[1];
    expect(submit.props.disabled).toBe(!value.trim());
    content.props.onSubmit({ preventDefault() {} });
    expect(results).toEqual(value.trim() ? [value.trim()] : []);
  }
});

test('dialog Tab cycles visible enabled controls and keeps focus inside both boundaries', async () => {
  const { cycleDialogFocus } = await import('../app/src/ds/Dialog');
  const focused: string[] = [];
  const element = (name: string) => ({ focus: () => focused.push(name), matches: () => false, closest: () => null, getClientRects: () => [1] }) as unknown as HTMLElement;
  const first = element('first'), last = element('last');
  const dialog = { querySelectorAll: () => [first, last], ownerDocument: { activeElement: last } } as unknown as HTMLDialogElement;
  let prevented = 0;
  cycleDialogFocus(dialog, { key: 'Tab', shiftKey: false, preventDefault: () => { prevented++; } });
  expect(focused).toEqual(['first']);
  (dialog.ownerDocument as any).activeElement = first;
  cycleDialogFocus(dialog, { key: 'Tab', shiftKey: true, preventDefault: () => { prevented++; } });
  expect(focused).toEqual(['first', 'last']);
  expect(prevented).toBe(2);
  cycleDialogFocus(dialog, { key: 'Enter', shiftKey: false, preventDefault: () => { prevented++; } });
  expect(prevented).toBe(2);
});

test('dialog respects an inner control that already handled Tab', async () => {
  const { cycleDialogFocus } = await import('../app/src/ds/Dialog');
  const dialog = { querySelectorAll: () => { throw new Error('Handled Tab must not be intercepted'); } } as unknown as HTMLDialogElement;
  expect(() => cycleDialogFocus(dialog, { key: 'Tab', shiftKey: false, defaultPrevented: true, preventDefault: () => {} })).not.toThrow();
});

test('a radio group is one Tab stop: checked radio, else first forward and last backward', async () => {
  const { cycleDialogFocus } = await import('../app/src/ds/Dialog');
  const focused: string[] = [];
  const doc = { activeElement: null as unknown };
  const form = {};
  const element = (id: string, extra: Record<string, unknown> = {}) => {
    const node = { id, focus() { focused.push(id); doc.activeElement = node; }, matches: () => false, closest: () => null, getClientRects: () => [1], ...extra };
    return node as unknown as HTMLElement & { checked?: boolean };
  };
  const radio = (id: string, checked = false) => element(id, { type: 'radio', name: 'choice', form, checked });
  const close = element('close'), a = radio('a'), b = radio('b', true), c = radio('c'), submit = element('submit');
  const dialog = { querySelectorAll: () => [close, a, b, c, submit], ownerDocument: doc } as unknown as HTMLDialogElement;
  const tab = (shiftKey = false) => { cycleDialogFocus(dialog, { key: 'Tab', shiftKey, preventDefault() {} }); return focused.at(-1); };

  doc.activeElement = close;
  expect([tab(), tab(), tab()]).toEqual(['b', 'submit', 'close']);
  expect([tab(true), tab(true), tab(true)]).toEqual(['submit', 'b', 'close']);
  // Arrow keys may leave focus on another radio of the group: Tab leaves the whole group from there.
  doc.activeElement = c;
  expect(tab()).toBe('submit');
  doc.activeElement = a;
  expect(tab(true)).toBe('close');
  // Nothing checked: enter at the first radio forward, at the last one backward.
  b.checked = false;
  doc.activeElement = close;
  expect(tab()).toBe('a');
  doc.activeElement = submit;
  expect(tab(true)).toBe('c');
});

test('Dialog is aria-modal, focuses [data-autofocus] else the first control, returns focus, and Tab continues from the heading', async () => {
  const { Dialog } = await import('../app/src/ds/Dialog');
  const { installDom, mount, unmount, tick } = await import('./app-setup-health-dom');
  const { enableFocusQueries, findAll, focusName, pressTab } = await import('./app-focus-dom');
  const dom = installDom();
  try {
    enableFocusQueries(dom);
    const invoker = dom.doc.createElement('button');
    dom.container.appendChild(invoker);
    const host = dom.doc.createElement('div');
    dom.container.appendChild(host);
    const view = { ...dom, container: host };

    invoker.focus();
    await mount(view, <Dialog title="Plain" close={() => {}}><Button>Second</Button></Dialog>);
    await tick();
    expect(findAll(host, n => n.localName === 'dialog')[0].getAttribute('aria-modal')).toBe('true');
    expect(focusName(dom.doc.activeElement)).toBe('button:Close');
    await unmount(view);
    expect(dom.doc.activeElement).toBe(invoker);

    await mount(view, <Dialog title="Asks" close={() => {}}><h2 tabIndex={-1} data-autofocus>Question</h2><Button>First after</Button></Dialog>);
    await tick();
    expect(focusName(dom.doc.activeElement)).toBe('h2:Question');
    expect(pressTab(view)).toBe('button:First after');
    expect(pressTab(view)).toBe('button:Close');
    (findAll(host, n => n.localName === 'h2').at(-1)).focus();
    expect(pressTab(view, true)).toBe('button:Close');
    await unmount(view);
  } finally {
    dom.restore();
  }
});
