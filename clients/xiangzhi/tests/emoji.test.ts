import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseEmojiText,messageEmojiRecognition} from '../shared/emoji.js';
import {wechatEmojiMetadata} from '../server/emoji-metadata.js';
import {messageEvidenceHash} from '../server/contact-evidence.js';
import {messageObservation} from '../server/contact-context.js';
import {MediaAutomation} from '../server/media-automation.js';
import {Store} from '../server/store.js';
import type {Message} from '../shared/types.js';

const message:Message={id:'emoji-message',conversationId:'A',text:'这有啥[嘿哈]👍🏽😂',kind:'text',role:'peer',sentAt:'2026-10-14T00:00:00Z',sequence:1,source:'wechat',externalId:'1',aiAssisted:false};

test('local emoji parsing keeps original order and grapheme clusters without interpreting feelings',()=>{
  const result=parseEmojiText('好的[微笑]👍🏽😂👨‍👩‍👧‍👦🇨🇳1️⃣[语音][自定义指令]12')!;
  assert.deepEqual(result.tokens.map(token=>token.value),['[微笑]','👍🏽','😂','👨‍👩‍👧‍👦','🇨🇳','1️⃣']);
  assert.equal(result.tokens[1].name,'竖大拇指');assert.equal(result.tokens[2].name,'笑哭');
  assert.doesNotMatch(JSON.stringify(result),/喜欢你|讨厌|爱慕|已确认|人格/);
  assert.equal(parseEmojiText('纯文字123 # * [图片，未解析]'),undefined);
  assert.equal(parseEmojiText('[微笑]'.repeat(80))!.tokens.length,32);
  assert.equal(parseEmojiText('x'.repeat(10_001)),undefined);
});

test('common emoji descriptions list possible conventional uses while unknown glyphs stay descriptive',()=>{
  const result=parseEmojiText('[捂脸][嘿哈][微笑][呲牙][破涕为笑][抱拳][合十][爱心][摊手]😂🙂🤦')!;
  assert.equal(result.parserVersion,'wechat-emoji-v2');
  assert.match(result.tokens[0].description,/调侃.*自嘲.*前后文/);assert.match(result.tokens[2].description,/礼貌.*反讽/);
  assert.match(result.tokens[4].description,/无奈.*自嘲/);assert.match(result.tokens[5].description,/感谢.*请求/);
  assert.match(result.tokens[7].description,/不能确认关系/);assert.match(result.tokens[9].description,/无奈.*自嘲/);
  assert.match(result.tokens[10].description,/礼貌.*反讽/);assert.match(result.tokens[11].description,/调侃.*自嘲/);
  const fallback=parseEmojiText('🦑')!.tokens[0];assert.equal(fallback.name,'Unicode 表情');assert.equal(fallback.description,'“Unicode 表情”图形。');
  assert.ok(result.tokens.every(token=>token.description.length<=120));
});

test('raw text edits and imports derive fresh emoji descriptions, leaving the source unchanged',()=>{
  const original=message.text,parsed=messageEmojiRecognition(message)!;
  assert.equal(message.text,original);assert.equal(parsed.recognizedAt,message.sentAt);
  assert.equal(messageEmojiRecognition({...message,kind:'image'}),undefined);
  assert.deepEqual(messageObservation(message).emojiObservation?.tokens,parsed.tokens);
  assert.equal(messageObservation({...message,text:'删掉了表情'}).emojiObservation,undefined);
  const stateStore=new Store(':memory:');
  try{
    stateStore.update(state=>state.messages.push({...message,emojiRecognition:{...parsed,tokens:[{value:'WRONG',name:'WRONG',description:'WRONG'}]}}));
    assert.deepEqual(stateStore.read().messages[0].emojiRecognition,parsed);
    stateStore.update(state=>state.messages[0].text='新文字');
    assert.equal(stateStore.read().messages[0].emojiRecognition,undefined);
  }finally{stateStore.close();}
});

test('emoji evidence changes with actual source or sticker identity, never with parsing timestamps',()=>{
  const hash=messageEvidenceHash(message);
  assert.equal(messageEvidenceHash({...message,emojiRecognition:{...messageEmojiRecognition(message)!,recognizedAt:'different'}}),hash);
  assert.notEqual(messageEvidenceHash({...message,text:'[微笑]'}),hash);
  assert.notEqual(messageEvidenceHash({...message,kind:'emoji',wechatEmoji:{md5:'a'.repeat(32)}}),messageEvidenceHash({...message,kind:'emoji',wechatEmoji:{md5:'b'.repeat(32)}}));
  const ordinary={...message,text:'无表情'};
  const legacy=createHash('sha256').update(JSON.stringify([ordinary.id,ordinary.conversationId,ordinary.role,ordinary.text,ordinary.kind,ordinary.mediaStatus??null,ordinary.sourceFingerprint??null,ordinary.imageRecognition??null,ordinary.audioRecognition??null])).digest('hex');
  assert.equal(messageEvidenceHash(ordinary),legacy);
});

test('sticker metadata projects only bounded identifiers from Emoji objects or XML',()=>{
  const md5='a'.repeat(32);
  assert.deepEqual(wechatEmojiMetadata({Emoji:{md5:md5.toUpperCase(),xml:`<msg><emoji md5="${md5}" cdnurl="https://untrusted/private" aeskey="secret-key"/></msg>`}},'123'),{md5,localId:'123'});
  assert.deepEqual(wechatEmojiMetadata({Emoji:`<emoji md5='${md5}'/>`}),{md5});
  assert.equal(wechatEmojiMetadata({Emoji:{md5:'../../private'}}),undefined);
  assert.equal(wechatEmojiMetadata({Emoji:{md5},Text:`<emoji md5="${'b'.repeat(32)}"/>`}),undefined);
  assert.equal(wechatEmojiMetadata({Image:{md5}}),undefined);
  assert.equal(wechatEmojiMetadata({Emoji:`<emoji evil-md5="${md5}"/>`}),undefined);
  assert.equal(wechatEmojiMetadata({Emoji:{md5},oversized:'x'.repeat(32_001)}),undefined);
  assert.doesNotMatch(JSON.stringify(wechatEmojiMetadata({Emoji:{xml:`<emoji md5="${md5}" cdnurl="https://untrusted/private" aeskey="secret-key"/>`}})),/untrusted|private|secret|cdn|xml/);
});

test('new downloaded sticker automation uses only the selected contact image switch',async()=>{
  const store=new Store(':memory:');let calls=0;
  try{
    store.update(state=>{
      state.conversations.push({id:'A',name:'A',avatar:'A',color:'',note:'',autoReplyEnabled:false,channel:'wechat',externalId:'filehelper',createdAt:'',updatedAt:'',processing:{autoRecognizeImages:false},wechat:{enabled:true,initialized:true,cursor:'1',accountFingerprint:'fixture',lastCheckedAt:null,status:'ready',detail:''}});
      state.messages.push({...message,kind:'emoji',text:'[表情，待人工查看]',mediaStatus:'pending',autoMediaEligible:true});
    });
    const automation=new MediaAutomation(store,{recognize:async(id,kind)=>{calls++;assert.equal(id,message.id);assert.equal(kind,'image');}});
    await automation.tick();assert.equal(calls,0);
    store.update(state=>state.conversations[0].processing!.autoRecognizeImages=true);
    await automation.tick();assert.equal(calls,1);assert.equal(store.read().messages[0].autoMediaEligible,false);
    await automation.tick();assert.equal(calls,1);automation.stop();
  }finally{store.close();}
});
