import { render } from 'preact';
import { TopBar } from '../../app/src/shell/TopBar';
render(<div className="pc-app pc-app--offline"><TopBar title="Workspace" connected={false} planner={null} mode="" lastUpdate={null} onDelegate={()=>{}}/></div>,document.getElementById('app')!);
