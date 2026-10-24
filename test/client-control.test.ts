import { expect, test } from 'bun:test';
import { ClientControl } from '../src/clients/control';

test('client controls require an explicit live target and worker credential, hide credentials from discovery', () => {
  let now = 1000; const broker = new ClientControl(() => now);
  const worker = broker.enroll('app', 'main');
  expect(JSON.stringify(broker.targets())).not.toContain(worker.worker_token);
  expect(() => broker.request('missing', {type:'theme.set',value:'dark'})).toThrow();
  const request = broker.request(worker.client_id, {type:'theme.set',value:'dark'});
  expect(request.status).toBe('pending');
  expect(() => broker.request(worker.client_id, {type:'theme.set',value:'light'})).toThrow();
  expect(() => broker.claim(worker.client_id,'wrong')).toThrow();
  expect(broker.claim(worker.client_id,worker.worker_token)?.request_id).toBe(request.request_id);
  expect(broker.complete(request.request_id,worker.worker_token,{theme:'dark'}).status).toBe('complete');
  expect(() => broker.complete(request.request_id,worker.worker_token,{})).toThrow();
  now += 61000;
  expect(broker.targets()).toEqual([]);
});
test('requests time out honestly and cannot be acknowledged by another client', () => {
  let now = 0; const broker = new ClientControl(() => now);
  const a = broker.enroll('app','main'), b = broker.enroll('desktop','main');
  const request = broker.request(a.client_id,{type:'theme.get'});
  broker.claim(a.client_id,a.worker_token);
  expect(() => broker.complete(request.request_id,b.worker_token,{})).toThrow();
  now = 31000;
  expect(broker.result(request.request_id).status).toBe('failed');
  expect(broker.result(request.request_id).error).toBe('client_timeout');
  expect(() => broker.complete(request.request_id,a.worker_token,{})).toThrow();
});

test('tray navigation must target the main page so its unsaved-form guard and acknowledgment apply', () => {
  const broker = new ClientControl();
  for (const kind of ['app','desktop'] as const) {
    const tray = broker.enroll(kind,'tray');
    expect(() => broker.request(tray.client_id,{type:'navigate',route:'/settings'})).toThrow('main');
  }
});
