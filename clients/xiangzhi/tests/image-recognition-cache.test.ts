import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImageRecognition, Settings } from '../shared/types.js';
import { findImageRecognition, imageRecognitionIdentity, MAX_IMAGE_RECOGNITION_HISTORY, saveImageRecognition } from '../server/image-recognition-cache.js';

const settings:Settings={autoReplyEnabled:false,autoReplyMode:'draft',provider:'compatible',modelUrl:'https://reply.example/v1',modelName:'reply',apiKey:'reply-secret',allowRemoteModel:true,
  replyDelaySeconds:1,cooldownSeconds:1,dailyLimit:20,quietHoursEnabled:false,quietStart:'23:00',quietEnd:'08:00',
  vision:{provider:'qwen',modelUrl:'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',modelName:'qwen3.8-flash',apiKey:'image-secret',useReplyApiKey:false,allowRemoteModel:true}};
const result:ImageRecognition={summary:'test',visibleText:'TEST',facts:[],provider:'qwen',modelName:'qwen3.8-flash',recognizedAt:'2026-10-13T00:00:00Z'};

test('cache identity normalizes a model endpoint and excludes keys, authorization and thinking toggles',()=>{
  const identity=imageRecognitionIdentity(settings,Buffer.from('image'))!;
  const changed={...settings,apiKey:'rotated-reply-key',vision:{...settings.vision!,modelUrl:settings.vision!.modelUrl+'/chat/completions/',modelName:' qwen3.8-flash ',apiKey:'rotated-image-key',useReplyApiKey:true,allowRemoteModel:false,thinkingEnabled:true}};
  assert.deepEqual(imageRecognitionIdentity(changed,Buffer.from('image')),identity);
  const metadata=JSON.stringify(identity);assert.doesNotMatch(metadata,/secret|rotated|aliyun|https/);
  for(const variant of [
    {...settings,vision:{...settings.vision!,modelName:'qwen3.8-max'}},
    {...settings,vision:{...settings.vision!,modelUrl:'https://other.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'}},
    {...settings,vision:{...settings.vision!,provider:'compatible' as const}},
  ])assert.notEqual(imageRecognitionIdentity(variant,Buffer.from('image'))!.modelIdentity,identity.modelIdentity);
  assert.notEqual(imageRecognitionIdentity(settings,Buffer.from('different'))!.imageSha256,identity.imageSha256);
});

test('cache requires a selected model, handles the Codex default without network permission and rejects credential URLs',()=>{
  assert.equal(imageRecognitionIdentity({...settings,vision:undefined},Buffer.from('image')),null);
  assert.equal(imageRecognitionIdentity({...settings,vision:{...settings.vision!,provider:'disabled'}},Buffer.from('image')),null);
  const codex={...settings,vision:{...settings.vision!,provider:'codex' as const,modelName:'',modelUrl:'',allowRemoteModel:false}};
  assert.ok(imageRecognitionIdentity(codex,Buffer.from('image')));
  assert.notDeepEqual(imageRecognitionIdentity(codex,Buffer.from('image')),imageRecognitionIdentity({...codex,vision:{...codex.vision,modelName:'selected-codex'}},Buffer.from('image')));
  assert.notDeepEqual(imageRecognitionIdentity(codex,Buffer.from('image')),imageRecognitionIdentity({...codex,vision:{...codex.vision,modelName:'default'}},Buffer.from('image')));
  assert.throws(()=>imageRecognitionIdentity({...settings,vision:{...settings.vision!,modelUrl:'https://secret:password@example.com/v1'}},Buffer.from('image')),/用户名|密码/);
});

test('bounded history keeps image/model pairs distinct and replaces exact duplicate entries',()=>{
  const identity=imageRecognitionIdentity(settings,Buffer.from('image'))!;
  let history=saveImageRecognition(undefined,identity,result);
  assert.deepEqual(findImageRecognition(history,identity),result);
  const newer={...result,summary:'updated'};
  history=saveImageRecognition(history,identity,newer);assert.equal(history.length,1);assert.deepEqual(findImageRecognition(history,identity),newer);
  assert.equal(findImageRecognition(history,{...identity,imageSha256:'other'}),undefined);
  for(let i=0;i<MAX_IMAGE_RECOGNITION_HISTORY;i++)history=saveImageRecognition(history,{...identity,imageSha256:String(i)},result);
  assert.equal(history.length,MAX_IMAGE_RECOGNITION_HISTORY);assert.equal(findImageRecognition(history,identity),undefined);
});
