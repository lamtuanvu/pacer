import type { SetupChecklist } from '../../../src/setup/checklist';
export const pluginInstructions='In Orca Settings > Plugins, uninstall the marketplace pacer if installed and turn on the plugin system. Under Development, add the installed folder to the development plugin paths, then enable pacer. Orca only refreshes plugin panels added as a development folder.';
export function setupModel(check:SetupChecklist) {
 return {complete:check.items.filter(i=>i.required).every(i=>i.status==='done'),items:check.items.map(i=>({...i,
 action:i.id==='strategy'?'planner':i.id==='service'||i.id==='link'?'service':i.id.startsWith('agent:')?'agent':i.id==='live'?'plugin':'check',
 command:i.id==='service'||i.id==='link'?'pacer service install':undefined,
 label:i.status==='done'?'Done':i.status==='failed'?'Needs attention':'Not done'}))};
}
