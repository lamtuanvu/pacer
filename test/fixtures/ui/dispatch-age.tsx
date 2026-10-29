import { render } from 'preact';
import { useTick } from '../../../app/src/screens/dispatch/Dispatch';
import { ago } from '../../../src/view-model/time';

// Renders the Dispatch update age with a snapshot taken five seconds before the first render and no later re-render.
const at = Date.now() / 1000 - 5;
function Fixture() {
  const now = useTick(at + 5);
  return <p id="age">updated {ago(at, now)}</p>;
}
render(<Fixture />, document.getElementById('fixture')!);
