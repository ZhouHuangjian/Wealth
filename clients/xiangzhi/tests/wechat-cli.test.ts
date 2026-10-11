import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectWechat, parseWechatPage, queryWechat, parseWechatContacts, searchWechatContacts } from '../server/wechat-cli.js';

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
      const page = await queryWechat({...query, after: '72057594037927937', since: 1700000000, offset: 2});
      assert.equal(page.records.length, 1);
      const captured = JSON.parse(await readFile(join(directory, 'wx-cli.args'), 'utf8'));
      assert.deepEqual(captured.args, ['query', 'filehelper', '--no-server', '--format', 'json', '--limit', '3', '--offset', '2', '--order', 'desc', '--after-sort-seq', '72057594037927937', '--since', '1700000000']);
      assert.equal(captured.secret, undefined);
      await queryWechat({...query, after: '0'});
      const zeroCursor = JSON.parse(await readFile(join(directory, 'wx-cli.args'), 'utf8'));
      assert.deepEqual(zeroCursor.args.slice(-2), ['--after-sort-seq', '0']);
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
