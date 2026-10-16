import type { SetupChecklist } from '../../../src/setup/checklist';
export const pluginInstructions='In Orca Settings > Plugins, uninstall the marketplace pacer if installed and turn on the plugin system. Under Development, add the installed folder to the development plugin paths, then enable pacer. Orca only refreshes plugin panels added as a development folder.';
export function setupModel(check:SetupChecklist) {
 return {complete:check.items.filter(i=>i.required).every(i=>i.status==='done'),items:check.items.map(i=>({...i,
 action:i.id==='strategy'?'planner':i.id==='service'||i.id==='link'?'service':i.id.startsWith('agent:')&&i.id!=='agent:agy'?'agent':i.id==='live'?'plugin':'check',
 command:i.status!=='done'&&(i.id==='service'||i.id==='link')?'pacer service install':undefined,
 guidance:i.status!=='done'&&i.id==='link'?'Start pacer: pacer service install':undefined,
 detail:i.id==='strategy'&&i.status!=='done'&&(!i.detail||i.detail.includes('no strategy found'))?'No strategy yet. Choose a planner to create one.':i.detail,
 label:i.status==='done'?'Done':i.status==='failed'?'Needs attention':'Not done'}))};
}
