import { expect, test } from 'bun:test';
import { previewLines } from '../app/src/screens/trace/output-preview';
import { buildPrompt } from '../src/exec/prompt';
const brief = {goal:'Implement the assigned change\nDo not echo this line',repo:'/tmp/fixture-repo',acceptance:'bun test'};
test('overview excludes the executor prompt and brief, then keeps the last two meaningful lines', () => {
  expect(previewLines(buildPrompt(brief,'preview'),brief)).toBe('');
  expect(previewLines(`${buildPrompt(brief,'preview')}\nFirst progress\n${brief.goal}\nUpdated /home/developer/project/file.ts\nTesting /private/var/folders/xx/random/T/run/check.ts`,brief))
    .toBe('Updated ~/project/file.ts\nTesting check.ts');
});
test('overview hides user/system JSON and raw events; renders assistant messages with safe paths', () => {
  const records = [
    {type:'user',message:{content:[{type:'text',text:buildPrompt(brief,'preview') }]}},
    {type:'thread.started',id:'opaque'},
    {type:'item.completed',item:{type:'agent_message',text:'Edited /tmp/run/result.ts\nRunning checks'}},
  ];
  expect(previewLines(records.map(r=>JSON.stringify(r)).join('\n'),brief)).toBe('Edited result.ts\nRunning checks');
  expect(previewLines('user\nsecret prompt text\ncodex\nWorking\nUnknown',brief)).toBe('Working');
});

test('excerpt handles instructions and output split across log chunks', async () => {
  const {previewReader} = await import('../app/src/screens/trace/output-preview');
  const reader = previewReader(brief);
  reader.push('PACER_ROLE=exe');
  reader.push('cutor: private instructions\nprivate brief\nco');
  reader.push('dex\nEdited /tmp/result.ts\nRun');
  expect(reader.push('ning checks',true)).toBe('Edited result.ts\nRunning checks');
});
