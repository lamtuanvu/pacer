import { expect, test } from 'bun:test';
import { plannerAgent, consentAction, updateModel } from '../app/src/model/settings';
test('planner consent targets the agent and preserves account in config', () => {
 expect(plannerAgent('codex#team')).toBe('codex');
 expect(consentAction({agent:'codex',files:['skills/pacer'],undo:'pacer uninstall codex'},'codex#team','install')).toEqual({op:'config.set',params:{key:'planner',value:'codex#team',integrations:'install'}});
 expect(consentAction({agent:'codex',files:[],undo:'undo'})).toEqual({op:'agent.connect',params:{agent:'codex',consent:true}});
 expect(() => consentAction(undefined,'codex','install')).toThrow();
 expect(() => consentAction({agent:'claude-code',files:[],undo:'undo'},'codex','install')).toThrow();
});
test('update state reflects checked versions and restarting', () => {
 expect(updateModel({current:'1',latest:'2',available:true},false)).toEqual({label:'Update available: 2',canUpdate:true});
 expect(updateModel(undefined,true).label).toBe('Updating… pacer will restart');
});
test('failed or disabled checks never claim up to date or offer a downgrade', () => {
 expect(updateModel({current:'2',latest:'1',available:false},false).canUpdate).toBe(false);
 expect(updateModel({current:'2',latest:null,error:'offline'},false).label).toBe('Update check failed');
 expect(updateModel({current:'2',latest:null,disabled:true},false).label).toBe('Update checking disabled');
});
