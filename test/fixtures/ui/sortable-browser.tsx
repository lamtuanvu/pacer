import { render } from 'preact';
import { useState } from 'preact/hooks';
import { SortableList } from '../../../app/src/ds/SortableList';
import { SaveBar } from '../../../app/src/ds/SaveBar';
import { orderChanges } from '../../../app/src/model/dispatcher-setup';

const labels: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', cursor: 'Cursor' };
const saved = ['codex', 'claude', 'opencode', 'cursor'];

function Fixture() {
  const [order, setOrder] = useState(saved);
  const [saves, setSaves] = useState(0);
  return <main>
    <SortableList label="Allowed executors" items={order.map(key => ({ key, label: labels[key]! }))}
      onReorder={setOrder} onRemove={key => setOrder(current => current.filter(item => item !== key))} />
    <SaveBar count={orderChanges(saved, order)} onDiscard={() => setOrder(saved)} onSave={() => setSaves(value => value + 1)} />
    <output data-testid="order">{order.join(',')}</output>
    <output data-testid="saves">{saves}</output>
  </main>;
}

render(<Fixture />, document.getElementById('root')!);
