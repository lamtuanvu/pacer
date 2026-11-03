import { z } from 'zod';
import type { OpDef } from './ops';
import { createAgentSession, listAgentSessions, getAgentSession, changeAgentSession } from '../session/agents';
const task=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),id=z.string().uuid();
const op=<P extends z.ZodTypeAny>(def:OpDef<P>)=>def as unknown as OpDef;
const change=z.object({task_id:task,id,expect_rev:z.number().int().positive()}).strict();
export const agentSessionOps:Record<string,OpDef>={
 'session.agent.list':op({description:'List independently controlled interactive agents belonging to tasks.',params:z.object({task_id:task.optional()}).strict(),handler:(ctx,p)=>listAgentSessions(ctx,p.task_id)}),
 'session.agent.get':op({description:'Read one task-owned interactive agent session and its current attempt.',params:z.object({task_id:task,id}).strict(),handler:(ctx,p)=>getAgentSession(ctx,p.task_id,p.id)}),
 'session.agent.create':op({description:'Start an idempotent independent interactive agent in an existing task workspace, without creating another task.',params:z.object({task_id:task,request_id:task,executor:z.string().min(1).max(256),request:z.string().min(1).max(200000)}).strict(),handler:(ctx,p)=>createAgentSession(ctx,p)}),
 'session.agent.end':op({description:'End only the selected agent session, retaining its output and workspace.',params:change,handler:(ctx,p)=>changeAgentSession(ctx,p,'end')}),
 'session.agent.retry':op({description:'Start a fresh native conversation for an ended agent session, retaining earlier attempts.',params:change,handler:(ctx,p)=>changeAgentSession(ctx,p,'retry')}),
 'session.agent.resume':op({description:'Resume the selected native conversation with its original executor and account.',params:change,handler:(ctx,p)=>changeAgentSession(ctx,p,'resume')}),
};
