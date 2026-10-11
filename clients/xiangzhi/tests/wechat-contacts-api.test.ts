import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../server/app.js';

test('contact picker requires a local session and search term without binding or reading messages', async t => {
  const searched: string[]=[];
  const instance=createApplication({databasePath:':memory:',seed:false,profileManifestPath:null,
    inspectCodex:async()=>({available:false,version:null,message:'synthetic'}),
    inspectWechat:()=>({available:true,message:'synthetic'}),
    queryWechat:async()=>{throw new Error('contact picker must not query messages');},
    searchWechatContacts:async q=>{searched.push(q);return {contacts:[{externalId:'wxid_synthetic',name:'虚构朋友'}],hasMore:false};},
  });
  const server=instance.app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});instance.close();});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/api/wechat/contacts?q=test`)).status,401);
  const session=await fetch(`${base}/api/session`);
  const cookie=session.headers.get('set-cookie')!.split(';')[0];
  const headers={Cookie:cookie};
  assert.equal((await fetch(`${base}/api/wechat/contacts`,{headers})).status,400);
  assert.equal((await fetch(`${base}/api/wechat/contacts?q=`,{headers})).status,400);
  const response=await fetch(`${base}/api/wechat/contacts?q=${encodeURIComponent('虚构')}`,{headers});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{contacts:[{externalId:'wxid_synthetic',name:'虚构朋友'}],hasMore:false});
  assert.deepEqual(searched,['虚构']);
  assert.equal(instance.store.read().conversations.length,0);
  assert.equal(instance.store.read().messages.length,0);
});
