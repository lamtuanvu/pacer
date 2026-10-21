import { render } from 'preact';
import { useState } from 'preact/hooks';
import { Button } from '../../../app/src/ds/Button';
import { useOverviewPage } from '../../../app/src/screens/overview-page';

function Fixture() {
  const [scope, setScope] = useState('all');
  const [total, setTotal] = useState(13);
  const page = useOverviewPage(Array.from({ length: total }, (_, i) => i), 'Tasks', 5, scope);
  return <><Button onClick={() => setScope('repo')}>Change repository</Button>
    <Button onClick={() => setTotal(2)}>Remove tasks</Button>
    <Button onClick={() => setTotal(13)}>Restore tasks</Button>
    <div id="rows">{page.rows.map(i => <p key={i}>Task {i + 1}</p>)}</div>{page.footer}</>;
}
render(<Fixture />, document.getElementById('fixture')!);
