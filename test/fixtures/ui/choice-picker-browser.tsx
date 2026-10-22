import { render } from 'preact';
import { useState } from 'preact/hooks';
import { ChoicePicker, type ChoiceOption } from '../../../app/src/ds/ChoicePicker';
import { Field } from '../../../app/src/ds/Controls';
import { Dialog } from '../../../app/src/ds/Dialog';

const initial: ChoiceOption[] = [
  { value: 'codex', label: 'Codex · work' },
  { value: 'claude', label: 'Claude Code · personal', disabled: true, reason: 'Sign in first' },
  { value: 'opencode', label: 'OpenCode · team', description: 'Uses team account' },
  { value: 'long', label: 'A-very-long-executor-name-with-no-breaks-at-all-that-must-fit-in-a-narrow-viewport' },
];
const many: ChoiceOption[] = Array.from({ length: 40 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}` }));

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
    <Field label="Long list"><ChoicePicker id="long-list" value="" options={many} onValueChange={() => {}} /></Field>
    <form style="margin-top:260px" onSubmit={event => { event.preventDefault(); setSubmitted(true); }}>
      <Field label="Repository"><ChoicePicker id="repo" value={second} options={initial} searchable onValueChange={setSecond} /></Field>
      <output data-testid="form-status">{submitted ? 'submitted' : 'idle'}</output>
    </form>
    <button id="remove" onClick={() => setOptions(initial.filter(option => option.value !== 'codex'))}>Remove Codex</button>
    <button id="open-modal" onClick={() => setModal(true)}>Open dialog</button>
    <div style="position:fixed;bottom:8px;left:8px;width:300px">
      <Field label="Bottom edge"><ChoicePicker id="bottom-choice" value="" options={many} searchable onValueChange={() => {}} /></Field>
    </div>
    <a href="#next">Next focus</a>
    {modal && <Dialog title="Picker dialog" close={() => setModal(false)}>
      <Field label="In dialog"><ChoicePicker id="dialog-choice" value={first} options={initial} onValueChange={setFirst} /></Field>
      <button id="after-dialog-choice" onClick={() => setModal(false)}>After picker</button>
    </Dialog>}
  </main>;
}

render(<Preview />, document.getElementById('root')!);
