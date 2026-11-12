import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeCtx } from './helpers';
import { createTask } from '../src/tasks/store';
import { upgradeSession, type SessionWS } from '../src/serve/session-ws';
import { encodeHeader, encodeRecord, FrameType } from '../src/session/framing';
import { attemptRecording, sessionAttemptDirectory } from '../src/session/service';
import type { Ctx } from '../src/types';

function recordedDir(ctx: Ctx, task: string, attempt: number, output = ''): string {
  const dir = join(ctx.pacerHome, 'runs', task, String(attempt));
  mkdirSync(dir, { recursive: true });
  // The recording log stores output frames with the log's type 1 (Recording.output); the route replays them as wire output frames.
  writeFileSync(join(dir, 'session.log'), Buffer.concat([
    encodeHeader({ cols: 80, rows: 24, startedAt: 0, generation: 0 }),
    output ? encodeRecord(1, 0, Buffer.from(output)) : Buffer.alloc(0),
  ]));
  return dir;
}

async function upgrade(ctx: Ctx, id: string, search = '') {
  let data: SessionWS | undefined;
  const response = await upgradeSession(
    new Request(`http://localhost/session${search}`),
    { upgrade: (_req: Request, opts: { data: SessionWS }) => { data = opts.data; return true; } } as any,
    ctx,
    id,
  );
  return { status: response?.status ?? 101, body: response ? await response.text() : null, data };
}

test('the task session route replays a recorded attempt read-only and answers 409 without one', async () => {
  const ctx = fakeCtx(),
    task = createTask(ctx, { brief: { goal: 'fixture', repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 10 });
  recordedDir(ctx, task.id, 1, 'first attempt output');
  recordedDir(ctx, task.id, 2, 'second attempt output');
  const run = (search: string) => upgrade(ctx, task.id, search);

  // A recorded earlier attempt upgrades and replays its own output, an exit frame and no controller.
  const second = await run('?attempt=2');
  expect(second.status).toBe(101);
  expect(second.data?.replay?.started).toBe(false);
  const frames = second.data!.replay!.frames;
  expect(frames.some(frame => frame.type === FrameType.snapshot)).toBe(true);
  expect(frames.filter(frame => frame.type === FrameType.output).map(frame => frame.data.toString())).toEqual(['second attempt output']);
  expect(frames.at(-1)).toMatchObject({ type: FrameType.exit });
  const exit = JSON.parse(frames.at(-1)!.data.toString());
  expect(exit.controller).toBeUndefined();

  // Another attempt replays its own recording; the latest attempt still replays without the param.
  const first = await run('?attempt=1');
  expect(first.data!.replay!.frames.filter(frame => frame.type === FrameType.output).map(frame => frame.data.toString())).toEqual(['first attempt output']);
  expect((await run('')).status).toBe(101);

  // No recording in the addressed run directory answers 409, like the latest-attempt route.
  const missing = await run('?attempt=3');
  expect(missing.status).toBe(409);
  expect(missing.body).toBe('Live session unavailable');
  expect((await run('?attempt=0')).status).toBe(400);
  expect((await run('?attempt=')).status).toBe(400);
  expect((await run('?attempt=abc')).status).toBe(400);
  expect((await run('?attempt=1&from=abc')).status).toBe(400);

  // An unknown task stays 404 with or without the param.
  expect((await upgrade(ctx, 't-20261102-090145-e376', '?attempt=1')).status).toBe(404);
  expect((await upgrade(ctx, 't-20261102-090145-e376')).status).toBe(404);
});

test('attempt directories alias only the current run and recording checks mirror the route', async () => {
  const ctx = fakeCtx(),
    task = createTask(ctx, { brief: { goal: 'fixture', repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 10 });
  recordedDir(ctx, task.id, 2);
  expect(sessionAttemptDirectory(ctx, task.id, 2)).toBe(join(ctx.pacerHome, 'runs', task.id, '2'));
  expect(attemptRecording(ctx, task.id, 2)).toBe(true);
  expect(attemptRecording(ctx, task.id, 3)).toBe(false);
  expect(attemptRecording(ctx, 't-20261102-090145-e376', 1)).toBe(false);
  expect(() => sessionAttemptDirectory(ctx, task.id, 0)).toThrow();
});
