import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import type {Conversation,Message} from '../shared/types.js';
import {legacyRemoteSnapshot,MAX_REMOTE_PROFILE_BYTES,parseProfileCommand,patchCommandSchema,remoteConversationRevision,remoteConversationV2,remoteProfile,
  remoteProfileRevision,remoteSettingsRevision,remoteSettingsSchema,remoteSettingsV2,remoteSnapshotV2} from '../server/remote-protocol.js';

const at='2026-10-14T01:00:00.000Z';
const conversation=():Conversation=>({id:randomUUID(),name:'测试朋友',avatar:'测',color:'green',note:'用户备注',autoReplyEnabled:false,channel:'wechat',externalId:'wxid_synthetic',createdAt:at,updatedAt:at,
  wechat:{enabled:true,initialized:true,cursor:'private_cursor',accountFingerprint:'private_account',lastCheckedAt:at,status:'reading',detail:'private_path'},
  processing:{intentEnabled:true,affinityEnabled:true,memoryEnabled:true,autoRecognizeImages:true,replyModels:[{id:'qwen',provider:'compatible',modelPreset:'qwen',modelName:'qwen-synthetic'}]},
  basisFacts:[{id:randomUUID(),category:'interest',content:'喜欢骑行',sourceNote:'用户补充',createdAt:at,updatedAt:at,sourceMessageIds:['private_message'],sourceMessageHashes:{private_message:'private_hash'}}],
  memory:{summary:'下周确认路线',openTopics:['路线'],entries:[{id:randomUUID(),kind:'openTopic',text:'周五确认',status:'pending',origin:'model',createdAt:at,sourceMessageIds:['private_message'],sourceMessageHashes:{private_message:'private_hash'}},
    {id:randomUUID(),kind:'fact',text:'已忽略的猜测',status:'rejected',origin:'model',createdAt:at,sourceMessageIds:['private_message']}],throughSequence:100,sourceDigest:'private_source_digest',compressedMessageHashes:{private_message:'private_hash'},provider:'qwen',modelName:'qwen-synthetic',updatedAt:at}});
const revision='a'.repeat(64);

test('remote projection exposes only controls and requested profile, never local source data or credentials',()=>{
  const store=new Store(':memory:');try{
    store.update(state=>{state.settings.apiKey='synthetic-private-secret';state.settings.modelUrl='https://private-model.invalid';state.settings.analysis={provider:'qwen',modelName:'synthetic',modelUrl:'https://private-model.invalid',apiKey:'synthetic-analysis-secret',useReplyApiKey:false,allowRemoteModel:true};});
    const c=conversation(),settings=store.read().settings;
    c.note='凭据 synthetic-private-secret';c.basisFacts![0].sourceNote='Bearer opaque_secret';
    const snapshot=remoteSnapshotV2(settings,[c],[],{wechatAvailable:true,codexAvailable:true,codexModels:[{id:'codex-synthetic',label:'测试模型',inputModalities:['text','image']}]},[settings.apiKey]);
    const profile=remoteProfile(c,[settings.apiKey]);
    const wire=JSON.stringify([snapshot,profile]);
    for(const secret of ['synthetic-private-secret','synthetic-analysis-secret','private-model.invalid','private_message','private_hash','private_source_digest','private_account','private_cursor','opaque_secret'])assert.ok(!wire.includes(secret),secret);
    assert.equal(profile.memory?.entries.length,1);assert.equal(profile.basisFacts[0].origin,'manual');
    assert.ok(!('memory'in snapshot.conversations[0]));assert.ok(!('basisFacts'in snapshot.conversations[0]));
    const legacy=legacyRemoteSnapshot(snapshot) as any;
    assert.equal(legacy.version,1);assert.deepEqual(Object.keys(legacy.capabilities).sort(),['codexAvailable','wechatAvailable']);
    assert.ok(!('revision'in legacy.settings));assert.ok(!('analysis'in legacy.settings));assert.ok(!('processing'in legacy.conversations[0]));
  }finally{store.close();}
});

test('revisions react to meaningful private service/config and profile edits but remain stable while polling',()=>{
  const store=new Store(':memory:');try{
    const settings=store.read().settings,c=conversation();
    const sr=remoteSettingsRevision(settings),cr=remoteConversationRevision(c),pr=remoteProfileRevision(c);
    assert.equal(remoteSettingsRevision({...settings,remoteManagementEnabled:!settings.remoteManagementEnabled}),sr);
    assert.notEqual(remoteSettingsRevision({...settings,apiKey:'new_private_key'}),sr);
    c.wechat!.cursor='later_cursor';c.wechat!.lastCheckedAt='2026-10-14T02:00:00.000Z';c.updatedAt='2026-10-14T02:00:00.000Z';
    assert.equal(remoteConversationRevision(c),cr);assert.equal(remoteProfileRevision(c),pr);
    c.basisFacts![0].sourceMessageHashes!['private_message']='new_hash';assert.notEqual(remoteProfileRevision(c),pr);assert.equal(remoteConversationRevision(c),cr);
    c.processing!.affinityEnabled=false;assert.notEqual(remoteConversationRevision(c),cr);
  }finally{store.close();}
});

test('affinity snapshot preserves zero, scopes peer results, and hides score after switch off',()=>{
  const c=conversation();
  const messages:Message[]=[{id:randomUUID(),conversationId:c.id,role:'peer',text:'synthetic',sequence:1,source:'manual',sentAt:at,externalId:null,aiAssisted:false,
    insights:{conversationId:c.id,messageId:'synthetic',intents:[],affinity:{score:0,confidence:50,evidence:['synthetic']},uncertainty:'仅测试',provider:'qwen',modelName:'synthetic',analyzedAt:at}},
    {id:randomUUID(),conversationId:randomUUID(),role:'peer',text:'foreign',sequence:9,source:'manual',sentAt:at,externalId:null,aiAssisted:false,
      insights:{conversationId:'foreign',messageId:'foreign',intents:[],affinity:{score:98,confidence:50,evidence:['foreign']},uncertainty:'仅测试',provider:'qwen',modelName:'synthetic',analyzedAt:at}}];
  messages[0].insights!.messageId=messages[0].id;
  assert.equal(remoteConversationV2(c,messages).affinity,0);
  messages.push({...messages[0],id:randomUUID(),sequence:2,insights:{...messages[0].insights!,affinity:{score:null,confidence:0,evidence:[]}}});
  messages.at(-1)!.insights!.messageId=messages.at(-1)!.id;
  assert.equal(remoteConversationV2(c,messages).affinity,null);
  c.processing!.affinityEnabled=false;assert.equal(remoteConversationV2(c,messages).affinity,null);
});

test('global and per-person settings reject secret fields and require expected revisions for new controls',()=>{
  assert.ok(remoteSettingsSchema.safeParse({replyDelaySeconds:5}).success);
  assert.ok(!remoteSettingsSchema.safeParse({analysis:{provider:'qwen',modelName:'synthetic'}}).success);
  assert.ok(remoteSettingsSchema.safeParse({analysis:{provider:'qwen',modelName:'synthetic'},expectedRevision:revision}).success);
  for(const field of ['apiKey','modelUrl','useReplyApiKey','allowRemoteModel'])assert.ok(!remoteSettingsSchema.safeParse({analysis:{provider:'qwen',modelName:'synthetic',[field]:'private'},expectedRevision:revision}).success);
  const id=randomUUID();assert.ok(!patchCommandSchema.safeParse({id,processing:{intentEnabled:true}}).success);
  assert.ok(patchCommandSchema.safeParse({id,processing:{replyModels:null,analysisModel:null,memoryModel:null},expectedRevision:revision}).success);
  assert.ok(!patchCommandSchema.safeParse({id,processing:{analysisModel:{id:'x',provider:'compatible',modelName:'x',modelUrl:'https://private.invalid'}},expectedRevision:revision}).success);
  assert.ok(!remoteSettingsSchema.safeParse({expectedRevision:revision}).success);
});

test('profile edits carry only their exact allowed fields and revision, independent generation uses only person id',()=>{
  const id=randomUUID(),entryId=randomUUID(),factId=randomUUID();
  assert.deepEqual(parseProfileCommand('conversation.basis.generate',{id}),{id});
  assert.deepEqual(parseProfileCommand('conversation.memory.compress',{id}),{id});
  assert.deepEqual(parseProfileCommand('conversation.basis.patch',{id,factId,content:'新内容',expectedRevision:revision}),{id,factId,content:'新内容',expectedRevision:revision});
  assert.deepEqual(parseProfileCommand('conversation.memory.entry.patch',{id,entryId,status:'approved',expectedRevision:revision}),{id,entryId,status:'approved',expectedRevision:revision});
  assert.throws(()=>parseProfileCommand('conversation.memory.patch',{id,summary:'changed'}));
  assert.throws(()=>parseProfileCommand('conversation.memory.entry.patch',{id,entryId,sourceMessageIds:['private'],expectedRevision:revision}));
  assert.throws(()=>parseProfileCommand('conversation.profile.get',{id,messages:['raw']}));
  assert.throws(()=>parseProfileCommand('conversation.basis.add',{id,category:'interest',content:'Bearer private_secret',expectedRevision:revision}));
});

test('large valid profiles include all 132 visible memories and reject overflow without truncation',()=>{
  const c=conversation(),template=c.memory!.entries[0];
  c.memory!.entries=Array.from({length:132},(_,index)=>({...template,id:randomUUID(),text:`记忆 ${index}`}));
  const projected=remoteProfile(c);assert.equal(projected.memory!.entries.length,132);assert.ok(Buffer.byteLength(JSON.stringify(projected))<MAX_REMOTE_PROFILE_BYTES);
  c.memory!.entries.push({...template,id:randomUUID()});assert.throws(()=>remoteProfile(c),/过大/);
});

test('snapshot constructor projects model catalog fields and rejects malformed remote catalog metadata',()=>{
  const store=new Store(':memory:');try{
    const settings=store.read().settings;
    assert.throws(()=>remoteSnapshotV2(settings,[],[],{wechatAvailable:true,codexAvailable:true,codexModels:[{id:'sk-synthetic-secretkey',label:'bad',inputModalities:['text']}]}));
    const snapshot=remoteSnapshotV2(settings,[],[],{wechatAvailable:true,codexAvailable:true,codexModels:[{id:'codex-synthetic',label:'测试',inputModalities:['text'],...( {privatePath:'/private/user'} as any)}]});
    assert.ok(!JSON.stringify(snapshot).includes('privatePath'));assert.ok(!JSON.stringify(snapshot).includes('/private/user'));
    assert.equal(remoteSettingsV2(settings).revision.length,64);
  }finally{store.close();}
});
