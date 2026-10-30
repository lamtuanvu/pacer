import { render } from 'preact';
import { ConnectChanges } from '../../../app/src/screens/setup/steps';
import type { AgentPreview } from '../../../app/src/screens/setup/model';

declare global { interface Window { pacerPreviewFixture: AgentPreview } }

render(<main style="max-width:640px;margin:auto"><ConnectChanges planner="codex" preview={window.pacerPreviewFixture} /><button>Continue</button></main>, document.getElementById('root')!);
