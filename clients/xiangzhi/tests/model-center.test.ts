import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ContactInsights,Conversation,PublicState,Settings} from '../shared/types.js';
import {Store} from '../server/store.js';
import {ContactModelCenter,NumericInsights,SettingsPage} from '../src/App.js';
import {ContactAnalysisProgress,HistoryReadProgress,ModelCenterOverview,modelAssignments} from '../src/model-center.js';

const noOp=()=>{};
function settings():Settings{
  const store=new Store(':memory:');const base=store.read().settings;store.close();
  const model={provider:'codex' as const,modelName:'gpt-example',modelUrl:'https://private-service.example/v1',apiKey:'PRIVATE-MODEL-KEY',useReplyApiKey:false,allowRemoteModel:true};
  return {...base,provider:'codex',modelName:'gpt-main',apiKey:'PRIVATE-REPLY-KEY',modelUrl:'https://private-reply.example/v1',allowRemoteModel:true,
    replyModels:[{id:'qwen-one',provider:'compatible',modelPreset:'qwen',modelName:'qwen3.8-flash'},
      {id:'codex-two',provider:'codex',modelName:'gpt-comparison'}],
    analysis:model,memory:{...model,modelName:'gpt-memory'},vision:{...model,modelName:'gpt-vision'},
    audio:{...model,provider:'qwen',modelName:'qwen3.8-omni-flash'}};
}
function contact():Conversation{
  return {id:'synthetic-contact',name:'合成联系人',note:'',avatar:'合',color:'green',channel:'wechat',externalId:'synthetic-wechat',autoReplyEnabled:false,createdAt:'2026-10-22T00:00:00Z',updatedAt:'2026-10-22T00:00:00Z',
    wechat:{enabled:false,initialized:true,cursor:'private-cursor',accountFingerprint:'private-account',lastCheckedAt:null,status:'paused',detail:'',
      history:{status:'complete',cursor:'private-history',offset:0,scanned:2351,added:2351,lastCheckedAt:null,detail:'本机历史读取完成'}}};
}
function publicState():PublicState{
  const store=new Store(':memory:');const state=store.read();store.close();
  const raw=settings();const {apiKey,vision,audio,analysis,memory,...global}=raw;
  const publicModel=(value:NonNullable<Settings['analysis']>)=>{const {apiKey,...rest}=value;return {...rest,hasApiKey:!!apiKey};};
  return {...state,conversations:[contact()],settings:{...global,hasApiKey:!!apiKey,vision:publicModel(vision!),audio:{...publicModel(audio!),provider:'qwen'},analysis:publicModel(analysis!),memory:publicModel(memory!)},knowledge:[],
    runtime:{channel:'simulator',bridgeConfigured:false,bridgeReceiveConfigured:false,bridgeSendConfigured:false,autoRunning:false,modelLabel:'Codex',learnedProfileError:null,
      codexAvailable:true,codexVersion:'synthetic',codexStatus:'测试可用',wechatAvailable:true,wechatStatus:'测试可用',draftSyncConfigured:false,draftInboxConfigured:false}};
}

test('one model center summarizes all five assignments without exposing credentials or service URLs',()=>{
  const value=settings();const before=JSON.stringify(value);
  const html=renderToStaticMarkup(createElement(ModelCenterOverview,{settings:value,selected:'analysis',onSelect:noOp}));
  assert.equal((html.match(/class="model-assignment(?: selected| )?"/g)||[]).length,5);
  assert.equal((html.match(/aria-pressed="true"/g)||[]).length,1);
  for(const title of ['回复草稿','图片与表情','语音转写','意图与好感度','档案与记忆'])assert.ok(html.includes(title),title);
  assert.match(html,/2 个模型比较/);assert.match(html,/阿里千问 · qwen3.8-flash/);assert.match(html,/Codex · gpt-comparison/);
  assert.doesNotMatch(html,/PRIVATE-|private-service|private-reply/);assert.equal(JSON.stringify(value),before);
});

test('contact assignments preserve default, single-main, and explicit comparison choices independently',()=>{
  const value=settings(),person=contact();
  assert.equal(modelAssignments(value,person).find(task=>task.id==='reply')!.count,2);
  person.processing={replyModels:[],analysisModel:{id:'analysis',provider:'codex',modelName:'gpt-contact-analysis'}};
  let assignments=modelAssignments(value,person);
  assert.equal(assignments.find(task=>task.id==='reply')!.label,'Codex · gpt-main');
  assert.equal(assignments.find(task=>task.id==='reply')!.custom,true);
  assert.equal(assignments.find(task=>task.id==='analysis')!.label,'Codex · gpt-contact-analysis');
  assert.equal(assignments.find(task=>task.id==='memory')!.custom,false);
  assert.equal(assignments.find(task=>task.id==='vision')!.label,'Codex · gpt-vision');
  assert.equal(assignments.find(task=>task.id==='audio')!.custom,false);
  person.processing.replyModels=[{id:'only',provider:'compatible',modelPreset:'qwen',modelName:'qwen3.8-max'}];
  assignments=modelAssignments(value,person);
  assert.equal(assignments.find(task=>task.id==='reply')!.label,'阿里千问 · qwen3.8-max');
  assert.equal(assignments.find(task=>task.id==='reply')!.count,1);
});

test('settings and contact dialogs retain all model editors in one center with provider-specific choices',()=>{
  const state=publicState();
  const page=renderToStaticMarkup(createElement(SettingsPage,{state,notify:noOp,refresh:async()=>{},busy:'',run:async()=>undefined,onOpenConversation:noOp}));
  const modelPanels=[...page.matchAll(/<section([^>]*data-model-task="([^"]+)"[^>]*)>/g)];
  assert.deepEqual(modelPanels.map(([,attributes,task])=>({task,hidden:attributes.includes('hidden')})),[
    {task:'reply',hidden:false},{task:'analysis',hidden:true},{task:'memory',hidden:true},{task:'vision',hidden:true},{task:'audio',hidden:true}]);
  const analysis=page.split('id="model-editor-analysis"')[1].split('</section>')[0];
  assert.match(analysis,/Codex 默认模型/);assert.doesNotMatch(analysis,/<option[^>]+value="qwen|<datalist/);
  const audio=page.split('id="model-editor-audio"')[1].split('</section>')[0];
  assert.match(audio,/qwen3.8-omni-flash/);assert.doesNotMatch(audio,/name="audio-provider"[^>]*value="codex"/);
  assert.doesNotMatch(page,/PRIVATE-/);assert.equal((page.match(/>保存设置<\/button>/g)||[]).length,1);
  const dialog=renderToStaticMarkup(createElement(ContactModelCenter,{conversation:state.conversations[0],state,busy:'',run:async()=>undefined,onClose:noOp,onOpenGlobal:noOp}));
  for(const task of ['reply','analysis','memory','vision','audio'])assert.match(dialog,new RegExp(`id="contact-model-${task}"`));
  assert.match(dialog,/打开全局模型中心/);assert.match(dialog,/跟随全局默认/);assert.match(dialog,/使用模型中心的全局默认/);
  assert.doesNotMatch(dialog,/PRIVATE-|private-service|private-reply/);
});

test('history completion waits for the pending tail and progress never mislabels a partial batch as finished',()=>{
  const person=contact();
  let html=renderToStaticMarkup(createElement(HistoryReadProgress,{conversation:person,messageCount:2351}));
  assert.match(html,/本机可用历史已完整读取/);assert.match(html,/2,351/);
  person.wechat!.history!.tail={cursor:'secret-tail',offset:50};
  html=renderToStaticMarkup(createElement(HistoryReadProgress,{conversation:person,messageCount:2351}));
  assert.match(html,/正在补齐完整历史/);assert.doesNotMatch(html,/本机可用历史已完整读取|secret-tail|private-history/);
  const stage=renderToStaticMarkup(createElement(ContactAnalysisProgress,{progress:[{feature:'memory',total:4000,processed:120,stage:'generating',updatedAt:'now'}]}));
  assert.match(stage,/120 \/ 4,000/);assert.match(stage,/本批历史准备已结束/);assert.doesNotMatch(stage,/已处理 4,000/);
  assert.equal(renderToStaticMarkup(createElement(ContactAnalysisProgress,{progress:[]})),'');
});

test('stale intent is retained with an explicit update notice; current results have no stale notice',()=>{
  const person=contact();person.processing={intentEnabled:true};
  const insight:ContactInsights={messageId:'synthetic-message',conversationId:person.id,provider:'codex',modelName:'gpt-example',analyzedAt:'2026-10-22T00:00:00Z',
    intents:[{label:'分享',percentage:80},{label:'关心',percentage:20}],affinity:null,uncertainty:'合成测试',stale:true};
  const old=renderToStaticMarkup(createElement(NumericInsights,{conversation:person,insights:insight}));
  assert.match(old,/已保存的旧分析 · 待更新/);assert.match(old,/纳入完整历史和当前配置/);
  assert.match(old,/分享 <strong>80%/);assert.match(old,/关心 <strong>20%/);
  const fresh=renderToStaticMarkup(createElement(NumericInsights,{conversation:person,insights:{...insight,stale:false}}));
  assert.doesNotMatch(fresh,/待更新|insight-stale-note/);assert.match(fresh,/分享 <strong>80%/);
});
