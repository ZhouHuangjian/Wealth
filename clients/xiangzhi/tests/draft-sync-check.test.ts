import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkDraftConnection, draftConnectionCheckUrl } from '../server/draft-sync-check.js';

const config = {url: 'https://wealth.example.test/api/v1/chat/ingest', token: 'synthetic-device-check-token-'.repeat(2), inboxToken: ''};
const receipt = {ok: true, device: {id: '501f6be4-9fde-4d86-a4a1-7bf8c521c236', name: '合成 Mac'}, checkedAt: '2026-10-11T04:00:00.123+00:00'};

test('verification derives only the exact Wealth path and sends no draft or conversation fields', async t => {
  for (const url of ['https://example.test/inbox', 'https://example.test/api/v1/chat/ingest/', 'http://example.test/api/v1/chat/ingest', 'https://user:pass@example.test/api/v1/chat/ingest', 'https://example.test/api/v1/chat/ingest?token=private']) {
    assert.equal(draftConnectionCheckUrl({...config, url}), null);
  }
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    calls++;assert.equal(url.href, 'https://wealth.example.test/api/v1/chat/device/check');
    assert.equal(options.redirect, 'error');assert.equal(options.method, 'POST');assert.equal(options.body, '{}');
    assert.deepEqual(options.headers, {'Content-Type': 'application/json', Authorization: `Bearer ${config.token}`});
    return Response.json(receipt);
  });
  assert.deepEqual(await checkDraftConnection(config), receipt);
  await assert.rejects(checkDraftConnection({...config, url:'https://example.test/other'}));assert.equal(calls, 1);
});

test('invalid, oversized or reflected acknowledgement never leaks a remote body or credentials', async t => {
  let response = () => Response.json(receipt);
  t.mock.method(globalThis, 'fetch', async () => response());
  for (const body of [{...receipt, ok:false}, {...receipt, extra:'private'}, {...receipt, device:{id:'not-uuid',name:'合成 Mac'}},
    {...receipt, device:{...receipt.device,name:'x'.repeat(81)}}, {...receipt, device:{...receipt.device,name:'\nprivate'}},
    {...receipt, device:{...receipt.device,name:config.token}}, {...receipt, checkedAt:'no-date'}]) {
    response = () => Response.json(body);
    await assert.rejects(checkDraftConnection(config), error => error instanceof Error && !error.message.includes(config.token) && !error.message.includes('private'));
  }
  for (const oversized of [false,true]) {
    response = () => new Response(oversized ? 'x'.repeat(4097) : 'private', {headers:{'Content-Type':'application/json',...(!oversized ? {'Content-Length':'9999'} : {})}});
    await assert.rejects(checkDraftConnection(config), /响应过大/);
  }
  response = () => new Response(`private ${config.token}`,{headers:{'Content-Type':'text/html'}});
  await assert.rejects(checkDraftConnection(config), /有效/);
  response = () => new Response(config.token,{headers:{'Content-Type':'application/json'}});
  await assert.rejects(checkDraftConnection(config), /有效/);
  response = () => new Response(config.token,{status:401});
  await assert.rejects(checkDraftConnection(config), error => error instanceof Error && !error.message.includes(config.token));
});

test('verification cannot follow a redirect to another endpoint', async () => {
  const requests: string[] = [];
  const server = createServer((req,res)=>{requests.push(req.url!);res.writeHead(302,{Location:'/other'});res.end();});
  server.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/chat/ingest`;
    await assert.rejects(checkDraftConnection({...config,url}), /无法验证/);
    assert.deepEqual(requests,['/api/v1/chat/device/check']);
  } finally {await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}
});

test('cancellation and fixed timeout end verification without retry or diagnostics disclosure', async t => {
  let calls=0;
  t.mock.method(globalThis,'fetch',async (_url: URL,options: RequestInit)=>{
    calls++;
    await new Promise<void>((_resolve,reject)=>{const abort=()=>reject(new Error(`private ${config.token}`)); if(options.signal?.aborted) abort();else options.signal?.addEventListener('abort',abort,{once:true});});
    return Response.json(receipt);
  });
  const controller=new AbortController();const pending=checkDraftConnection(config,controller.signal);controller.abort();
  await assert.rejects(pending,/已取消/);
  t.mock.method(AbortSignal,'timeout',(ms:number)=>{assert.equal(ms,10000);const timeout=new AbortController();queueMicrotask(()=>timeout.abort());return timeout.signal;});
  await assert.rejects(checkDraftConnection(config),/超时/);assert.equal(calls,2);
});
