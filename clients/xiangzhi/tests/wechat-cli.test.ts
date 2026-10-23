import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectWechat, parseWechatPage, queryWechat, parseWechatContacts, searchWechatContacts } from '../server/wechat-cli.js';
import { Store } from '../server/store.js';
import { WechatCollector } from '../server/wechat-collector.js';

const diagnostic = 'Auto-detected account: wxid_synthetic_123 (source: running-process)\nDirect encrypted open (SQLCipher)\n';
const row = {sort_seq: '72057594037927937', server_id: '9223372036854775801', msg_type: '1', sub_type: '0',
  sender: 'unused_sender', talker: 'filehelper', create_time: '1700000000', content: {Text: '测试文字 9223372036854775801'}, direction: 'outgoing'};
function fixture(rows: unknown[] = [row], hasMore = false): string {
  // JSON numeric tokens deliberately exceed IEEE-754 exact integer range.
  return JSON.stringify({items: rows, paging: {limit: 200, offset: 0, returned: rows.length, has_more: hasMore}, stats: {scanned: rows.length, skipped: 0}})
    .replace(/"(sort_seq|server_id|msg_type|sub_type|create_time)":"([0-9]+)"/g, '"$1":$2');
}

async function fakeCli(source: string, run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'xiangzhi-wechat-test-'));
  const executable = join(directory, 'wx-cli');
  const previous = process.env.XIANZHI_WECHAT_BIN;
  await writeFile(executable, `#!${process.execPath}\n${source}`, {mode: 0o700});
  process.env.XIANZHI_WECHAT_BIN = executable;
  try { await run(directory); }
  finally {
    if (previous === undefined) delete process.env.XIANZHI_WECHAT_BIN;
    else process.env.XIANZHI_WECHAT_BIN = previous;
    await rm(directory, {recursive: true, force: true});
  }
}

const success = `process.stderr.write(${JSON.stringify(diagnostic)});process.stdout.write(${JSON.stringify(fixture())});`;
const query = {contact: 'filehelper', limit: 3, order: 'desc' as const};

// Model the installed wx-cli contract, including the combination it rejects.
const nativePaging = `const fs=require('node:fs');const args=process.argv.slice(2);
const value=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;
const after=value('--after-sort-seq'),offset=Number(value('--offset')||0),limit=Number(value('--limit'));
fs.appendFileSync(__filename+'.calls',JSON.stringify(args)+'\\n');
if(after!==undefined&&offset!==0){process.stderr.write('error: --offset is not supported with anchor queries');process.exit(1);}
let rows=JSON.parse(fs.readFileSync(__filename+'.rows','utf8'));
if(after!==undefined)rows=rows.filter(r=>BigInt(r.sort_seq)>BigInt(after));
if(value('--order')==='desc')rows.reverse();
const items=rows.slice(offset,offset+limit);
process.stderr.write(${JSON.stringify(diagnostic)});
process.stdout.write(JSON.stringify({items,paging:{limit,returned:items.length,has_more:offset+limit<rows.length},stats:{skipped:0}}));`;

test('native-compatible pagination resumes a saved boundary and completes long tied sequences without loss', async () => {
  const start = 72057594037927937n;
  const rows = Array.from({length: 1330}, (_, index) => ({...row,
    server_id: String(9223372036854770000n + BigInt(index)),
    sort_seq: String(index < 100 ? start + BigInt(index) : index < 1301 ? start + 100n : start + BigInt(index - 1200)),
  }));
  await fakeCli(nativePaging, async directory => {
    await writeFile(join(directory, 'wx-cli.rows'), JSON.stringify(rows));
    const seen: string[] = []; let after = String(start - 1n), offset = 0, complete = false;
    for (let iteration = 0; iteration < 20; iteration++) {
      const page = await queryWechat({contact:'filehelper',order:'asc',limit:200,after,offset});
      seen.push(...page.records.map(record => record.id));
      if (!page.hasMore) { complete = true; break; }
      assert.ok(page.records.length);
      const last = page.records.at(-1)!.sortSeq, cursor = String(BigInt(last) - 1n);
      offset = (cursor === after ? offset : 0) + page.records.filter(record => record.sortSeq === last).length;
      after = cursor;
    }
    assert.equal(complete, true);
    assert.deepEqual(seen, rows.map(record => record.server_id));
    const calls = (await readFile(join(directory,'wx-cli.calls'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[]);
    assert.ok(calls.some(args=>args.includes('--offset')&&Number(args[args.indexOf('--offset')+1])>200));
    assert.ok(calls.every(args=>!args.includes('--after-sort-seq')||!args.includes('--offset')));
    assert.ok(calls.every(args=>Number(args[args.indexOf('--limit')+1])<=200&&!args.includes('--all')));
  });
});

test('collector uses the real adapter contract to finish more than one native page and deduplicate rereads', async () => {
  await fakeCli(nativePaging, async directory => {
    const rows = Array.from({length: 865}, (_, index)=>({...row, sort_seq:String(index+1), server_id:String(9223372036854770000n+BigInt(index))}));
    await writeFile(join(directory,'wx-cli.rows'),JSON.stringify(rows));
    const store = new Store(':memory:');
    store.update(state=>{state.conversations.push({id:'native-test',name:'合成联系人',avatar:'',color:'',note:'',autoReplyEnabled:false,
      channel:'wechat',externalId:'filehelper',createdAt:'',updatedAt:'',wechat:{enabled:false,initialized:false,cursor:null,
        accountFingerprint:null,lastCheckedAt:null,status:'paused',detail:''}});});
    const live: boolean[] = [], collector = new WechatCollector(store,{onMessages:(_cid,_latest,isLive)=>{live.push(isLive);}});
    try {
      await collector.poll('native-test');
      assert.notEqual(store.read().conversations[0].wechat!.history!.status,'complete');
      for(let attempt=0;attempt<5&&store.read().conversations[0].wechat!.history!.status!=='complete';attempt++)await collector.poll('native-test');
      assert.equal(store.read().conversations[0].wechat!.history!.status,'complete');
      assert.deepEqual(store.read().messages.map(message=>message.externalId),rows.map(record=>record.server_id));
      await collector.poll('native-test');
      assert.equal(store.read().messages.length,865);assert.deepEqual(store.read().jobs,[]);
      assert.ok(live.every(value=>!value));assert.equal(store.read().conversations[0].wechat!.enabled,false);
    } finally {collector.stop();store.close();}
  });
});

test('unanchored fallback rejects account changes and sanitizes known native parameter failures', async () => {
  const rows=Array.from({length:3},(_,index)=>({...row,sort_seq:'100',server_id:String(index+1)}));
  await fakeCli(nativePaging.replace(`process.stderr.write(${JSON.stringify(diagnostic)});`,
    `process.stderr.write(after===undefined?${JSON.stringify(diagnostic.replace('synthetic_123','changed_account'))}:${JSON.stringify(diagnostic)});`),async directory=>{
    await writeFile(join(directory,'wx-cli.rows'),JSON.stringify(rows));
    await assert.rejects(queryWechat({contact:'filehelper',order:'asc',limit:2,after:'99',offset:2}),/账号在分页期间发生变化/);
  });
  await fakeCli(`process.stderr.write('secret-account error: --offset is not supported with anchor queries');process.exit(1);`,async()=>{
    await assert.rejects(queryWechat(query),error=>error instanceof Error&&/分页参数/.test(error.message)&&!/secret-account|密钥/.test(error.message));
  });
});

test('contact search projects only stable IDs and display names and never exports or reads messages', async () => {
  const contacts = JSON.stringify({items: [{user_name:'wxid_test',remark:'合成备注',nick_name:'合成昵称',alias:'alias',phone:'sensitive-phone',memo:'sensitive-memo'},
    {user_name:'wxid_test_2',remark:'',nick_name:'第二联系人'}], paging:{returned:2,has_more:true},stats:{skipped:0}});
  assert.deepEqual(parseWechatContacts(contacts), {contacts:[{externalId:'wxid_test',name:'合成备注'},{externalId:'wxid_test_2',name:'第二联系人'}],hasMore:true});
  const script = `const args=process.argv.slice(2); if(JSON.stringify(args)!==JSON.stringify(['contacts','--search','合成备注','--limit','50','--offset','0','--format','json','--no-server'])) process.exit(3);process.stdout.write(${JSON.stringify(contacts)});`;
  await fakeCli(script, async () => {
    const result=await searchWechatContacts(' 合成备注 ');
    assert.equal(result.contacts.length,2);assert.doesNotMatch(JSON.stringify(result),/sensitive|phone|memo/);
  });
  for (const q of ['', ' ', 'x'.repeat(101), '\0']) await assert.rejects(searchWechatContacts(q), /搜索词/);
  assert.throws(()=>parseWechatContacts('{"items":[],"paging":{"returned":1,"has_more":false},"stats":{"skipped":0}}'), /列表格式/);
});

test('WeChat preserves 64-bit IDs and numeric-looking text, scopes account identity, and accepts empty pages', () => {
  const page = parseWechatPage(fixture(), diagnostic, 'filehelper');
  assert.equal(page.records[0].id, '9223372036854775801');
  assert.equal(page.records[0].sortSeq, '72057594037927937');
  assert.equal(page.records[0].text, '测试文字 9223372036854775801');
  assert.equal(page.records[0].role, 'self');
  assert.equal(page.records[0].sentAt, '2023-11-14T22:13:20.000Z');
  assert.equal(page.records[0].mediaStatus, undefined);
  assert.match(page.accountFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(page.accountFingerprint.includes('wxid'), false);
  assert.notEqual(page.accountFingerprint, parseWechatPage(fixture(), diagnostic.replace('synthetic_123', 'synthetic_456'), 'filehelper').accountFingerprint);
  assert.deepEqual(parseWechatPage(fixture([]), diagnostic, 'filehelper').records, []);
});

test('WeChat media and system notifications become explicit pending placeholders without payload or XML', () => {
  const rows = ['3', '34', '43', '62', '47', '49', '49', '10000', '10002', '999'].map((type, index) => ({
    ...row, sort_seq: String(index + 1), server_id: index === 0 ? '0' : undefined,
    msg_type: type, sub_type: index === 5 ? '6' : '5', direction: 'incoming',
    content: {Text: '<msg>secret-payload</msg>', Image: {md5: 'secret-media-hash'}}, snippet: 'secret-snippet',
  }));
  const records = parseWechatPage(fixture(rows), diagnostic, 'filehelper').records;
  assert.deepEqual(records.map(record => record.kind), ['image', 'voice', 'video', 'video', 'emoji', 'file', 'link', 'system', 'system', 'unknown']);
  assert.equal(records[0].id, 'seq:1');
  assert.equal(records[0].role, 'peer');
  assert.equal(records[7].role, 'system');
  assert.ok(records.every(record => record.mediaStatus === 'pending'));
  assert.doesNotMatch(JSON.stringify(records), /secret|<msg>/);
});

test('image projection retains only valid MD5 and optional local IDs while omitting paths and payloads', () => {
  const records = parseWechatPage(fixture([{...row, msg_type: '3', local_id: '9223372036854775802',
    content: {Image: {md5: 'A'.repeat(32), path: '/sensitive/private.dat', xml: 'sensitive XML'}}}]), diagnostic, 'filehelper').records;
  assert.deepEqual(records[0].wechatImage, {localId: '9223372036854775802', md5: 'a'.repeat(32)});
  assert.doesNotMatch(JSON.stringify(records), /sensitive|private|xml/);
  const withoutLocalId = parseWechatPage(fixture([{...row, msg_type: '3', content: {Image: {md5: 'b'.repeat(32)}}}]), diagnostic, 'filehelper').records;
  assert.deepEqual(withoutLocalId[0].wechatImage, {md5: 'b'.repeat(32)});
});

test('WeChat text emojis parse locally and custom sticker rows retain only their MD5 identifiers',()=>{
  const records=parseWechatPage(fixture([
    {...row,content:{Text:'哈哈[嘿哈]😂'}},
    {...row,sort_seq:'72057594037927938',msg_type:'47',local_id:'222',content:{Emoji:{xml:`<msg><emoji md5="${'a'.repeat(32)}" cdnurl="https://private-url" aeskey="sensitive-key"/></msg>`}}},
  ]),diagnostic,'filehelper').records;
  assert.deepEqual(records[0].emojiRecognition?.tokens.map(item=>item.value),['[嘿哈]','😂']);
  assert.equal(records[0].text,'哈哈[嘿哈]😂');assert.equal(records[0].mediaStatus,undefined);
  assert.deepEqual(records[1].wechatEmoji,{md5:'a'.repeat(32),localId:'222'});
  assert.equal(records[1].kind,'emoji');assert.equal(records[1].mediaStatus,'pending');
  assert.doesNotMatch(JSON.stringify(records),/private-url|sensitive-key|<msg>|cdnurl/);
});

test('WeChat rejects wrong contacts, ambiguous directions, unsafe identifiers, missing accounts, and malformed pages', () => {
  for (const changed of [
    {...row, talker: 'someone_else'}, {...row, direction: 'unknown'}, {...row, direction: undefined},
    {...row, sort_seq: '0'}, {...row, sort_seq: '-2'}, {...row, sort_seq: '1.5'}, {...row, server_id: '-1'},
    {...row, content: {Text: 'x'.repeat(10_001)}}, {...row, content: {Image: {}}},
  ]) assert.throws(() => parseWechatPage(fixture([changed]), diagnostic, 'filehelper'), /格式/);
  assert.throws(() => parseWechatPage(fixture(), '', 'filehelper'), /格式/);
  assert.throws(() => parseWechatPage(fixture(), diagnostic + diagnostic.replace('synthetic_123', 'different'), 'filehelper'), /格式/);
  assert.throws(() => parseWechatPage(fixture([], true), diagnostic, 'filehelper'), /格式/);
  assert.throws(() => parseWechatPage(fixture(Array.from({length: 201}, () => row)), diagnostic, 'filehelper'), /格式/);
  assert.throws(() => parseWechatPage('{bad-secret-json', diagnostic, 'filehelper'), error => error instanceof Error && !error.message.includes('secret'));
  assert.throws(() => parseWechatPage(fixture().replace('"has_more":false', '"has_more":"false"'), diagnostic, 'filehelper'), /格式/);
  assert.throws(() => parseWechatPage(fixture().replace('"skipped":0', '"skipped":1'), diagnostic, 'filehelper'), /格式/);
  assert.throws(() => parseWechatPage(fixture().replace('"returned":1', '"returned":2'), diagnostic, 'filehelper'), /格式/);
  assert.throws(() => parseWechatPage(fixture().replace('"returned":1,', ''), diagnostic, 'filehelper'), /格式/);
});

test('WeChat launches only bounded query arguments without a shell, key retrieval, inherited application credentials, or media export', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-secret-should-not-inherit';
  try {
    await fakeCli(`const fs=require('node:fs');fs.writeFileSync(__filename+'.args',JSON.stringify({args:process.argv.slice(2),secret:process.env.OPENAI_API_KEY}));${success}`, async directory => {
      assert.equal(inspectWechat().available, true);
      const page = await queryWechat({...query, after: '72057594037927936', since: 1700000000, offset: 0});
      assert.equal(page.records.length, 1);
      const captured = JSON.parse(await readFile(join(directory, 'wx-cli.args'), 'utf8'));
      assert.deepEqual(captured.args, ['query', 'filehelper', '--no-server', '--format', 'json', '--limit', '3', '--order', 'asc', '--after-sort-seq', '72057594037927936', '--since', '1700000000']);
      assert.equal(captured.secret, undefined);
      await queryWechat({...query, after: '0'});
      const zeroCursor = JSON.parse(await readFile(join(directory, 'wx-cli.args'), 'utf8'));
      assert.deepEqual(zeroCursor.args.slice(-2), ['--after-sort-seq', '0']);
      await queryWechat({...query, offset:2});
      const unanchored = JSON.parse(await readFile(join(directory, 'wx-cli.args'), 'utf8'));
      assert.deepEqual(unanchored.args.slice(-4), ['--order', 'desc', '--offset', '2']);
    });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
  }
});

test('WeChat parameter and executable validation fail before launch', async () => {
  for (const invalid of [{contact: '-all'}, {contact: 'other; echo hi'}, {limit: 201}, {limit: 0}, {offset: -1}, {after: '-1'}, {since: NaN}]) {
    await assert.rejects(queryWechat({...query, ...invalid}), /参数/);
  }
  const previous = process.env.XIANZHI_WECHAT_BIN;
  try {
    process.env.XIANZHI_WECHAT_BIN = 'relative/wx-cli';
    assert.equal(inspectWechat().available, false);
    await assert.rejects(queryWechat(query), /绝对路径/);
    process.env.XIANZHI_WECHAT_BIN = '/does-not-exist/xiangzhi-test-wx-cli';
    assert.equal(inspectWechat().available, false);
    await assert.rejects(queryWechat(query), /无法启动/);
  } finally {
    if (previous === undefined) delete process.env.XIANZHI_WECHAT_BIN; else process.env.XIANZHI_WECHAT_BIN = previous;
  }
});

test('WeChat output limits and CLI failures never echo raw diagnostics or result contents', async () => {
  await fakeCli('process.stderr.write("sensitive-account-and-key");process.exit(1)', async () => {
    await assert.rejects(queryWechat(query), error => error instanceof Error && /读取失败/.test(error.message) && !/sensitive/.test(error.message));
  });
  await fakeCli('process.stdout.write("x".repeat(2*1024*1024+1));setInterval(()=>{},1000)', async () => {
    await assert.rejects(queryWechat(query), /2 MiB/);
  });
  await fakeCli('process.stderr.write("x".repeat(64*1024+1));setInterval(()=>{},1000)', async () => {
    await assert.rejects(queryWechat(query), /诊断输出过多/);
  });
});

test('WeChat cancellation stops a running CLI and already-cancelled queries do not launch', async () => {
  await fakeCli('setInterval(()=>{},1000)', async () => {
    const controller = new AbortController();
    const pending = queryWechat(query, controller.signal);
    controller.abort();
    await assert.rejects(pending, /取消/);
    await assert.rejects(queryWechat(query, controller.signal), /取消/);
  });
});

test('WeChat enforces the fixed 20 second timeout', async context => {
  await fakeCli('setInterval(()=>{},1000)', async () => {
    context.mock.timers.enable({apis: ['setTimeout']});
    try {
      const pending = queryWechat(query);
      const rejected = assert.rejects(pending, /20 秒/);
      context.mock.timers.tick(20_000);
      await rejected;
    } finally { context.mock.timers.reset(); }
  });
});

test('WeChat cleans up descendants even when the CLI leader exits successfully', {skip: process.platform === 'win32'}, async () => {
  await fakeCli(`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(__filename+'.pid',String(child.pid));child.unref();${success}`, async directory => {
    await queryWechat(query);
    const pid = Number(await readFile(join(directory, 'wx-cli.pid'), 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      await delay(25);
    }
    if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* best-effort test cleanup */ } }
    assert.equal(alive, false, 'background descendant should be terminated');
  });
});
