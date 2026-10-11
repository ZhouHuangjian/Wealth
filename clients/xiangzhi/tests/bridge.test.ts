import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSender, isBridgeConfigured, isBridgeReceiveConfigured, validateEndpoint } from '../server/bridge.js';
import type { Conversation } from '../shared/types.js';

const conversation:Conversation={id:'local-test',name:'测试会话',avatar:'测',color:'',note:'',autoReplyEnabled:true,channel:'webhook',externalId:'external-test',createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z'};
async function endpoint(handler:(req:IncomingMessage,res:ServerResponse)=>void){
  const server=createServer(handler);server.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  return {url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,close:()=>new Promise<void>((r,j)=>server.close(e=>e?j(e):r()))};
}

test('real HTTP bridge transport binds destination, auth, idempotency key and platform receipt',async()=>{
  let captured:unknown;
  const local=await endpoint((req,res)=>{let content='';req.on('data',chunk=>content+=chunk);req.on('end',()=>{captured={auth:req.headers.authorization,key:req.headers['idempotency-key'],body:JSON.parse(content)};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,messageId:'platform-receipt'}));});});
  try{
    const send=createSender({inboundToken:'x'.repeat(40),outboundUrl:local.url,outboundToken:'local-test-secret'});
    assert.equal(await send(conversation,'完全虚构的测试文字','attempt-123'),'platform-receipt');
    assert.deepEqual(captured,{auth:'Bearer local-test-secret',key:'attempt-123',body:{version:'1',conversationId:'external-test',text:'完全虚构的测试文字',idempotencyKey:'attempt-123'}});
  }finally{await local.close();}
});

test('bridge refuses unacknowledged responses and does not follow redirects',async()=>{
  let calls=0;
  const local=await endpoint((req,res)=>{calls++;if(req.url==='/redirect'){res.statusCode=302;res.setHeader('Location','/target');res.end();}else{res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}});
  try{
    await assert.rejects(createSender({inboundToken:'x'.repeat(40),outboundUrl:local.url,outboundToken:''})(conversation,'test','id-1'),/有效发送凭据/);
    await assert.rejects(createSender({inboundToken:'x'.repeat(40),outboundUrl:`${local.url}/redirect`,outboundToken:''})(conversation,'test','id-2'));
    assert.equal(calls,2);
  }finally{await local.close();}
});

test('plaintext remote endpoints and URL credentials are rejected; simulator needs no bridge',async()=>{
  assert.throws(()=>validateEndpoint('http://example.com/send'));
  assert.throws(()=>validateEndpoint('https://user:secret@example.com/send'));
  assert.equal(await createSender({inboundToken:'',outboundUrl:'',outboundToken:''})({...conversation,channel:'simulator'},'演练','demo'),undefined);
});

test('an inbound token enables receiving independently of outbound sending',async()=>{
  const receiveOnly={inboundToken:'x'.repeat(40),outboundUrl:'',outboundToken:''};
  assert.equal(isBridgeReceiveConfigured(receiveOnly),true);assert.equal(isBridgeConfigured(receiveOnly),false);
  assert.equal(isBridgeReceiveConfigured({...receiveOnly,inboundToken:'short'}),false);
  await assert.rejects(createSender(receiveOnly)(conversation,'不能发送','receive-only-attempt'),/尚未配置/);
  assert.equal(isBridgeConfigured({...receiveOnly,outboundUrl:'http://127.0.0.1:43210/send'}),true);
});
