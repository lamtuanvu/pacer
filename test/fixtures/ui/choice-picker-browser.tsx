import { render } from 'preact';
import { useState } from 'preact/hooks';
import { ChoicePicker, type ChoiceOption } from '../../../app/src/ds/ChoicePicker';
import { Field } from '../../../app/src/ds/Controls';

const initial: ChoiceOption[] = [
  { value: 'codex', label: 'Codex · work' },
  { value: 'claude', label: 'Claude Code · personal', disabled: true, reason: 'Sign in first' },
  { value: 'opencode', label: 'OpenCode · team', description: 'Uses team account' },
  { value: 'long', label: 'A-very-long-executor-name-with-no-breaks-at-all-that-must-fit-in-a-narrow-viewport' },
];

function Preview() {
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('codex');
  const [options, setOptions] = useState(initial);
  const [modal, setModal] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  return <main>
    <Field label="Executor" help="Choose one account">
      <ChoicePicker id="executor" value={first} options={options} onValueChange={setFirst} placeholder="Choose an executor…" />
    </Field>
    <form style="margin-top:260px" onSubmit={event => { event.preventDefault(); setSubmitted(true); }}>
      <Field label="Repository"><ChoicePicker id="repo" value={second} options={initial} searchable onValueChange={setSecond} /></Field>
      <output data-testid="form-status">{submitted ? 'submitted' : 'idle'}</output>
    </form>
    <button id="remove" onClick={() => setOptions(initial.filter(option => option.value !== 'codex'))}>Remove Codex</button>
    <button id="open-modal" onClick={() => setModal(true)}>Open dialog</button>
    <a href="#next">Next focus</a>
    {modal && <dialog ref={node => { if (node && !node.open) node.showModal(); }}>
      <Field label="In dialog"><ChoicePicker id="dialog-choice" value={first} options={initial} onValueChange={setFirst} /></Field>
      <button onClick={() => setModal(false)}>Close dialog</button>
    </dialog>}
  </main>;
}

render(<Preview />, document.getElementById('root')!);
