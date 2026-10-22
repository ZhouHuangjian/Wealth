import test from 'node:test';
import assert from 'node:assert/strict';
import type {Message} from '../shared/types.js';
import {fullHistoryContext,fullHistoryDigest,fullHistoryObservation,type HistoryCache} from '../server/full-history-context.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';

function message(index:number,text=`合成记录 ${index}`):Message{
  return {id:`m${index}`,conversationId:'contact-a',role:index%2?'peer':'self',text,sentAt:'2026-10-01T08:00:00Z',sequence:index,
    source:'wechat',externalId:`opaque-${index}`,aiAssisted:false,kind:'text'};
}
function cache(){const entries=new Map<string,unknown>();return {entries,api:{get:(ns,key)=>entries.get(`${ns}:${key}`),
  set:(ns,key,value)=>{entries.set(`${ns}:${key}`,value);}} satisfies HistoryCache};}
const input=(messages:{role:string;content:string}[])=>JSON.parse(messages[1].content);

test('short histories include every ordered non-system utterance and scope media observations without a model call',async()=>{
  const rows=[message(3,'[图片]'),message(1,'最早的完整合成记录'),{...message(2),role:'system' as const},message(4,'最后一条')];
  rows[0].kind='image';rows[0].mediaStatus='recognized';rows[0].imageRecognition={summary:'已识别内容',visibleText:'可见合成文字',facts:['合成图案'],provider:'qwen',modelName:'fixture',recognizedAt:''};
  let calls=0;const progress:unknown[]=[];
  const result=await fullHistoryContext(rows,'contact-a','model-a',async()=>{calls++;return '';},undefined,{onHistoryProgress:p=>progress.push(p)});
  assert.equal(calls,0);assert.equal(result.mode,'full');assert.equal(result.totalMessages,3);assert.equal(result.coveredMessages,3);assert.equal(result.lossy,false);
  const observed=result.messages as ReturnType<typeof fullHistoryObservation>[];
  assert.deepEqual(observed.map(row=>row.id),['m1','m3','m4']);assert.equal(observed[1].imageObservation!.visibleText,'可见合成文字');
  assert.deepEqual(progress,[{total:3,processed:0,stage:'reading'},{total:3,processed:3,stage:'complete'}]);
});

test('long utterances are fully segmented across bounded calls including their final characters and summaries cover all records',async()=>{
  const rows=Array.from({length:10},(_,index)=>message(index+1,`BEGIN-${index+1} ${'长句🙂'.repeat(3000)} END-${index+1}`));
  const parts=new Map<string,{part:number;parts:number;fragment:string}[]>(),progress:{total:number;processed:number;stage:string}[]=[];
  let calls=0;
  const result=await fullHistoryContext(rows,'contact-a','model-a',async messages=>{
    calls++;assert.ok(Buffer.byteLength(messages[1].content)<50_000);const context=input(messages);assert.equal(context.level,0);
    for(const item of context.messages){assert.equal(typeof item.fragment,'string');const group=parts.get(item.id)??[];group.push(item);parts.set(item.id,group);}
    return JSON.stringify({summary:`分段合成摘要 ${calls}`});
  },undefined,{onHistoryProgress:p=>progress.push(p)});
  assert.ok(calls>1);assert.equal(result.mode,'hierarchical');assert.equal(result.coveredMessages,rows.length);assert.equal(result.lossy,true);
  for(const row of rows){const segments=parts.get(row.id)!;assert.equal(segments.length,segments[0].parts);
    const reconstructed=JSON.parse(segments.sort((a,b)=>a.part-b.part).map(part=>part.fragment).join(''));
    assert.deepEqual(reconstructed,fullHistoryObservation(row));assert.ok(reconstructed.text.endsWith(`END-${row.sequence}`));}
  assert.equal(progress.at(-1)!.processed,rows.length);assert.equal(progress.at(-1)!.stage,'complete');
});

test('a long message that fits the final context remains a complete observation rather than fragmented JSON',async()=>{
  const row=message(1,`BEGIN ${'完整'.repeat(3500)} END`);
  assert.ok(Buffer.byteLength(row.text)>12_000);
  const result=await fullHistoryContext([row],'contact-a','model-a',async()=>{throw new Error('must not summarize');});
  assert.equal(result.mode,'full');assert.deepEqual(result.messages,[fullHistoryObservation(row)]);
});

test('reading progress counts a large message only after its final fragment was processed',async()=>{
  const row=message(1,'合成长发言🙂'.repeat(6000)),progress:{processed:number;stage:string}[]=[];
  let finalPartSeen=false;
  await fullHistoryContext([row],'contact-a','model-a',async messages=>{
    const context=input(messages);
    for(const part of context.messages??[])if(part.part===part.parts)finalPartSeen=true;
    return JSON.stringify({summary:'仍在逐段整理'});
  },undefined,{historyBudgetBytes:12_000,onHistoryProgress:p=>{
    progress.push(p);if(p.processed===1)assert.equal(finalPartSeen,true);
  }});
  assert.ok(progress.filter(p=>p.stage==='summarizing'&&p.processed===0).length>1);
  assert.equal(progress.at(-1)!.processed,1);
});

test('hierarchical reduction carries every source group through more than one summary level',async()=>{
  const rows=Array.from({length:60},(_,index)=>message(index+1,`BEGIN m${index+1} ${'合成内容'.repeat(2500)} END`));
  const leafIds=new Set<string>(),levels:number[]=[];
  const result=await fullHistoryContext(rows,'contact-a','model-a',async messages=>{
    const context=input(messages);levels.push(context.level);assert.ok(Buffer.byteLength(messages[1].content)<50_000);
    if(context.messages)for(const item of context.messages)leafIds.add(item.id);
    const ids=[...new Set<string>(JSON.stringify(context).match(/\bm\d+\b/g)??[])].sort();
    return JSON.stringify({summary:`${ids.join(',')} ${'摘要'.repeat(1600)}`});
  });
  assert.deepEqual(leafIds,new Set(rows.map(row=>row.id)));assert.ok(Math.max(...levels)>=2);
  assert.ok(Buffer.byteLength(JSON.stringify(result.summaries))<=48_000);
  for(const row of rows)assert.match(result.summaries.join('\n'),new RegExp(`\\b${row.id}\\b`));
});

test('successful segments survive a failed request and caches are isolated by contact, model and source revision',async()=>{
  const rows=Array.from({length:12},(_,index)=>message(index+1,`${'旧内容'.repeat(2200)}尾部-${index+1}`)),saved=cache();
  let attempts=0,fail=true;const calls:string[]=[];
  const complete=async(messages:{role:string;content:string}[])=>{const context=input(messages);calls.push(JSON.stringify(context));
    if(fail&&++attempts===2)throw new Error('synthetic interruption');return JSON.stringify({summary:`已读分段 ${context.level} ${calls.length}`});};
  await assert.rejects(fullHistoryContext(rows,'contact-a','model-a',complete,undefined,{historyCache:saved.api}),/synthetic interruption/);
  assert.equal(saved.entries.size,1);const first=calls[0];fail=false;
  const result=await fullHistoryContext(rows,'contact-a','model-a',complete,undefined,{historyCache:saved.api});
  assert.equal(result.coveredMessages,rows.length);assert.equal(calls.filter(call=>call===first).length,1,'successful first group is not paid for again');
  const before=calls.length;await fullHistoryContext(rows,'contact-a','model-a',complete,undefined,{historyCache:saved.api});assert.equal(calls.length,before);
  await fullHistoryContext(rows,'contact-a','model-b',complete,undefined,{historyCache:saved.api});assert.ok(calls.length>before);
  const afterOtherModel=calls.length;await fullHistoryContext(rows,'contact-a','model-a',complete,undefined,{historyCache:saved.api});assert.equal(calls.length,afterOtherModel);
  const afterModel=calls.length;await fullHistoryContext(rows,'contact-b','model-a',complete,undefined,{historyCache:saved.api});assert.ok(calls.length>afterModel);
  const priorDigest=fullHistoryDigest(rows);rows[0].text+='变化后的尾部';assert.notEqual(fullHistoryDigest(rows),priorDigest);
  const afterContact=calls.length;await fullHistoryContext(rows,'contact-a','model-a',complete,undefined,{historyCache:saved.api});assert.ok(calls.length>afterContact);
});

test('the SQLite history cache survives restart and reuses all validated summaries without a new model call',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'xiangzhi-history-test-')),path=join(directory,'state.sqlite');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const rows=Array.from({length:12},(_,index)=>message(index+1,`${'完整记录'.repeat(2000)}结尾-${index}`));
  let store=new Store(path),calls=0;
  const dependencies=()=>({historyCache:{get:(namespace:string,key:string)=>store.cacheGet(namespace,key),
    set:(namespace:string,key:string,value:unknown)=>store.cacheSet(namespace,key,value)}});
  const first=await fullHistoryContext(rows,'contact-a','model-a',async()=>{calls++;return JSON.stringify({summary:`已完成分段 ${calls}`});},undefined,dependencies());
  assert.ok(calls>1);store.close();store=new Store(path);
  try{const again=await fullHistoryContext(rows,'contact-a','model-a',async()=>{throw new Error('must use persisted cache');},undefined,dependencies());
    assert.deepEqual(again,first);
  }finally{store.close();}
});

test('cancellation does not save a late summary and retry reuses only previously completed segments',async()=>{
  const rows=Array.from({length:12},(_,index)=>message(index+1,'长篇内容'.repeat(2500))),saved=cache(),controller=new AbortController();let calls=0;
  await assert.rejects(fullHistoryContext(rows,'contact-a','model-a',async(_messages,signal)=>{
    assert.equal(signal,controller.signal);if(++calls===2)controller.abort();return JSON.stringify({summary:'合成分段摘要'});
  },controller.signal,{historyCache:saved.api}),/取消/);
  assert.equal(saved.entries.size,1);let retryCalls=0;
  const result=await fullHistoryContext(rows,'contact-a','model-a',async()=>{retryCalls++;return JSON.stringify({summary:'重试合成摘要'});},undefined,{historyCache:saved.api});
  assert.ok(retryCalls>0);assert.equal(result.coveredMessages,rows.length);
  const stopped=new AbortController();stopped.abort();await assert.rejects(fullHistoryContext(rows,'contact-a','model-a',async()=>{throw new Error('must not run');},stopped.signal),/取消/);
});
