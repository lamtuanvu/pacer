import { useState } from 'preact/hooks';
import { Button } from '../../ds/Button';
import { consentAction, type AgentPreview } from '../../model/settings';
import { pluginInstructions } from '../../model/setup';
import { useQuery, useAction, ErrorMessage, Dialog } from '../task-shared';
export function Consent({agent,planner,close,done}:{agent:string;planner?:string;close:()=>void;done:()=>void}) {
 const preview=useQuery<AgentPreview>('agent.preview',{agent}),action=useAction();
 function confirm(integrations:'install'|'skip') {const command=consentAction(preview.data,planner,integrations);void action.run(command.op,command.params,()=>{done();close();});}
 return <Dialog title={planner?'Change planner':`Connect ${agent}`} close={close}><p>Review the files pacer will change.</p><ErrorMessage error={preview.error}/>{preview.data&&<><ul>{preview.data.files.map(file=><li><code>{file}</code></li>)}</ul><p>Undo: <code>{preview.data.undo}</code></p>{planner&&<p>Changing and connecting also removes the previous planner's integration. Change only leaves hooks and the status line on the old planner until connected.</p>}<div className="row"><Button disabled={action.busy} onClick={()=>confirm('install')}>{planner?'Change and connect':`Connect ${agent}`}</Button>{planner&&<Button disabled={action.busy} onClick={()=>confirm('skip')}>Change only</Button>}</div></>}<div aria-live="polite"><ErrorMessage error={action.error}/></div></Dialog>;
}
export function CopyCommand({command}:{command:string}) {
 const [message,setMessage]=useState('');
 return <div className="row"><code>{command}</code><Button onClick={()=>void navigator.clipboard.writeText(command).then(()=>setMessage('Copied.'),()=>setMessage('Could not copy. Select the command and copy it.'))}>Copy command</Button><span aria-live="polite">{message}</span></div>;
}
export function PluginInstall({detail,done}:{detail?:string;done:()=>void}) {
 const action=useAction(),[path,setPath]=useState('');
 return <><p>{detail}</p><Button disabled={action.busy} onClick={()=>void action.run<{path:string}>('plugin.install',{},r=>{setPath(r.path);done();})}>Install Orca panel</Button>{path&&<p>Installed at <code>{path}</code></p>}<p>{pluginInstructions}</p><div aria-live="polite"><ErrorMessage error={action.error}/>{action.message}</div></>;
}
