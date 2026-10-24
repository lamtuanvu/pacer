import {expect,test} from 'bun:test';
import {writeFileSync,chmodSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {conversationIdentity} from '../src/session/native-identity';
import {fakeCtx,tmpDir} from './helpers';

for(const [label,body] of [
 ['missing history',`echo '{"error":"missing"}'; exit 1`],
 ['invalid output',`echo 'not json'`],
 ['wrong identity',`echo '{"data":{"id":"ses_unrelated"}}'`],
 ['invalid identity',`echo '{"data":{"id":"../escape"}}'`],
] as const) test(`resume refuses ${label} without losing the requested identity`,async()=>{
 const ctx=fakeCtx({env:{PATH:process.env.PATH}});mkdirSync(ctx.pacerHome,{recursive:true});
 const bin=tmpDir(),file=join(bin,'opencode');writeFileSync(file,`#!/bin/sh\n${body}\n`);chmodSync(file,0o700);
 await expect(conversationIdentity(ctx,{agent:'opencode',version:'2.1.2',taskId:'task',sessionId:'ses_exact',workspace:bin,env:{PATH:bin}})).rejects.toThrow('could not recover');
});
test('native identity creation inherits the account environment and workspace',async()=>{
 const ctx=fakeCtx({env:{PATH:process.env.PATH}});mkdirSync(ctx.pacerHome,{recursive:true});
 const bin=tmpDir(),file=join(bin,'opencode');
 writeFileSync(file,`#!/bin/sh\nif [ "$PWD" = "$EXPECTED_WORKSPACE" ] && [ "$PACER_KEY_TEST" = 'child-only' ]; then echo '{"data":{"id":"ses_new"}}'; else exit 1; fi\n`);chmodSync(file,0o700);
 expect(await conversationIdentity(ctx,{agent:'opencode',version:'2.1.2',taskId:'task',workspace:bin,env:{PATH:bin,EXPECTED_WORKSPACE:bin,PACER_KEY_TEST:'child-only'}})).toEqual({id:'ses_new',source:'assigned'});
});
