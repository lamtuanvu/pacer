import { render } from 'preact';
import { useState } from 'preact/hooks';
import { ChoicePicker, type ChoiceOption } from '../../../app/src/ds/ChoicePicker';
import { Field } from '../../../app/src/ds/Controls';
import { Dialog } from '../../../app/src/ds/Dialog';
import { StartSessionForm } from '../../../app/src/screens/StartSession';
import { Delegate } from '../../../app/src/screens/Delegate';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { initialState } from '../../../app/src/data/store';

const initial: ChoiceOption[] = [
  { value: 'codex', agent: 'codex#work', label: 'Codex · work' },
  { value: 'claude', agent: 'claude#personal', label: 'Claude Code · personal', disabled: true, reason: 'Sign in first' },
  { value: 'opencode', agent: 'opencode#byteplus', label: 'OpenCode · team', description: 'Uses team account' },
  { value: 'long', agent: 'custom', label: 'A-very-long-executor-name-with-no-breaks-at-all-that-must-fit-in-a-narrow-viewport' },
];
const many: ChoiceOption[] = Array.from({ length: 40 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}` }));
const delegateState = { ...initialState(), connected: true, features: { readModel: true, ops: new Set(['repo.list']) } };
const delegateApi = { call: async (op: string) => op === 'repo.list'
  ? [{ key: 'project', label: 'Project', path: '/tmp/project', branches: ['main'] }]
  : op === 'routing.route' ? { ranked: [], excluded: [] } : [] } as never;

function Preview() {
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('codex');
  const [options, setOptions] = useState(initial);
  const [modal, setModal] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [startDraft, setStartDraft] = useState({ repo: '', executor: '' });
  const [started, setStarted] = useState(false);
  const [modalDelegate, setModalDelegate] = useState(false);
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
    <div data-testid="edge-wrapper" style="position:fixed;bottom:8px;left:8px;width:300px">
      <Field label="Bottom edge"><ChoicePicker id="bottom-choice" value="" options={many} searchable onValueChange={() => {}} /></Field>
    </div>
    <div data-testid="edge-wrapper" style="position:fixed;top:230px;right:8px;width:300px">
      <Field label="Middle edge"><ChoicePicker id="middle-choice" value="" options={many} searchable onValueChange={() => {}} /></Field>
    </div>
    <a href="#next">Next focus</a>
    <div id="start-validation">
      <StartSessionForm request="Fix tests" repo={startDraft.repo} repos={[{ key: 'project', label: 'Project', path: '/tmp/project' }]}
        preparation={{ repo: { key: 'project', label: 'Project', path: '/tmp/project' }, branches: ['main'], base: 'main', checkouts: [],
          executors: [{ id: 'codex', agent: 'codex', account: 'work', version: '0.163.0', available: true,
            capabilities: { interactive: true, resume: true, launchImages: true, liveImages: false, files: true } }] }}
        mode="new" base="main" checkout="" executor={startDraft.executor} items={[]} busy={false}
        onField={(key, value) => { if (key === 'repo' || key === 'executor') setStartDraft(previous => ({ ...previous, [key]: value })); }}
        onFiles={() => {}} onRemove={() => {}} onRetry={() => {}} onSubmit={() => setStarted(true)} />
      <output data-testid="start-status">{started ? 'started' : 'idle'}</output>
    </div>
    <button id="open-delegate-fixture" onClick={() => setModalDelegate(true)}>Open delegate fixture</button>
    {modalDelegate && <TaskContext.Provider value={{ state: delegateState, api: delegateApi }}>
      <Delegate close={() => setModalDelegate(false)} />
    </TaskContext.Provider>}
    {modal && <Dialog title="Picker dialog" close={() => setModal(false)}>
      <Field label="In dialog"><ChoicePicker id="dialog-choice" value={first} options={initial} onValueChange={setFirst} /></Field>
      <button id="after-dialog-choice" onClick={() => setModal(false)}>After picker</button>
    </Dialog>}
  </main>;
}

render(<Preview />, document.getElementById('root')!);
