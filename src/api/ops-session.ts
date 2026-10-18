import { z } from 'zod';
import type { OpDef } from './ops';
import { sessionInfo, openSession } from '../session/service';
import { takeoverTask } from '../session/takeover';
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const op=<P extends z.ZodTypeAny>(def:OpDef<P>)=>def as unknown as OpDef;
export const sessionOps:Record<string,OpDef>={
 'task.takeover':op({description:'Stop a local headless run and resume its conversation interactively.',params:z.object({id}),handler:(ctx,p)=>takeoverTask(ctx,p.id)}),
 'task.session':op({description:'Session host, capabilities and available viewers.',params:z.object({id}),handler:(ctx,p)=>sessionInfo(ctx,p.id)}),
 'task.attach':op({description:'Open a task viewer, or return a command when unavailable.',params:z.object({id,target:z.enum(['app','orca','here','terminal','tmux'])}),handler:(ctx,p)=>openSession(ctx,p.id,p.target)}),
};
