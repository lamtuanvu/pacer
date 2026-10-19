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
    expect(html).toContain('Rejection note<textarea required autofocus');
    const input = content.props.children[1].props.children[1];
    input.props.onInput({ currentTarget: { value: 'Updated reason' } });
    expect(changes).toEqual(['Updated reason']);
    const submit = content.props.children[2].props.children[1];
    expect(submit.props.disabled).toBe(!value.trim());
    content.props.onSubmit({ preventDefault() {} });
    expect(results).toEqual(value.trim() ? [value.trim()] : []);
  }
});
